#!/usr/bin/env node
import { cpSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

import { connected, listen, pick, request } from "./bridge.js";

const VERSION = "1.0.0";

const INSTRUCTIONS = `efferent is the person's own Chromium browser (Chrome, Edge, Brave, Thorium...), with their sign-ins, reached through an extension they installed. It works in a window of its own that it never brings to the front, so it never takes their keyboard, mouse or screen.
- open a page first: with no tab it opens in your own window and answers with the page's elements by ref, so never read it again right after. Never navigate a tab in the person's own window unless they asked.
- act runs many steps in one call and answers with the page after: fill every field of a form, then click submit last.
- For a search, open the site's search address directly (amazon.com/s?k=..., google.com/search?q=...) rather than typing into its box.
- read with find narrows a long page to the elements and lines that hold those words: use it for prices, results and buttons on busy pages.
- Refs look like 12, or 3:12 inside a frame. A ref goes stale after the page changes: use the refs from the latest answer.
- If a site ignores a click or key, repeat that step with trusted true: it uses the browser's debugger for real input, which some browsers announce with a bar at the top.
- Before you buy, book or send, check the item against every condition they gave, on its own page. After an action that changes something, look again before you say it worked.`;

const TAB = { type: "number", description: "Tab id. Defaults to the last tab you opened or used in that browser." };
const BROWSER = { type: "string", description: "Which connected browser, by its name in browsers. Defaults to the first one connected." };

const TOOLS = [
	{ name: "browsers", description: "The browsers connected through the efferent extension, with their names, and what each has done this session. reload true reloads the extension in one browser after its files were edited.", inputSchema: { type: "object", properties: { reload: { type: "boolean" }, browser: BROWSER } } },
	{ name: "tabs", description: "Every tab in a browser: yours (in your own window) and the person's, marking the one they used last.", inputSchema: { type: "object", properties: { browser: BROWSER } } },
	{ name: "open", description: "Open an address. With no tab it opens in a new tab of your own window, which stays behind the person's windows (show true brings it to the front instead); with tab it navigates that tab. Answers with the page's elements by ref.", inputSchema: { type: "object", properties: { url: { type: "string" }, tab: TAB, show: { type: "boolean" }, browser: BROWSER }, required: ["url"] } },
	{ name: "read", description: "A tab's title, address and interactive elements by ref. find keeps only the elements and text lines (with the lines around them) holding every one of its words, with | between alternatives ('out of 5 stars | Add to cart'); text true adds the page's words.", inputSchema: { type: "object", properties: { tab: TAB, find: { type: "string" }, text: { type: "boolean" }, max: { type: "number", description: "Most elements to list, 150 by default." }, browser: BROWSER } } },
	{
		name: "act",
		description: 'Run steps in a tab in order, waiting for the page to settle after each, and answer with what ran and the page after. Steps: {click: ref or visible text}, {fill: ref, value} (text box, dropdown by option text, checkbox true/false, rich editor), {type: text} (into the focused field), {press: "Enter" | "ctrl+a" | "Escape"}, {hover: ref}, {scroll: pixels or ref}, {go: address}, {back: true}, {forward: true}, {reload: true}, {wait: ms or "text to wait for"}. A target can also be "css:selector". Add trusted: true to a click, type or press (or to the whole call) for real input through the debugger.',
		inputSchema: { type: "object", properties: { tab: TAB, actions: { type: "array", items: { type: "object" }, maxItems: 40 }, trusted: { type: "boolean" }, browser: BROWSER }, required: ["actions"] },
	},
	{ name: "screenshot", description: "A picture of a tab. Slower than read: use it for layout, images and charts.", inputSchema: { type: "object", properties: { tab: TAB, browser: BROWSER } } },
	{ name: "eval", description: "Run JavaScript in a tab and answer its value (JSON for objects). An expression, or statements whose last value is the answer; wrap await in an async function.", inputSchema: { type: "object", properties: { js: { type: "string" }, tab: TAB, browser: BROWSER }, required: ["js"] } },
	{ name: "close", description: "Close a tab.", inputSchema: { type: "object", properties: { tab: TAB, browser: BROWSER } } },
];

const last = new Map();
const text = (value) => ({ content: [{ type: "text", text: value }] });

async function into(args, method, params = {}) {
	const b = await pick(args.browser);
	const tab = method === "open" ? args.tab : (args.tab ?? last.get(b.id));
	if (["read", "act", "shot", "eval", "close"].includes(method) && tab == null) throw new Error("No tab yet: open a page first, or pass a tab from tabs.");
	const result = await request(b, method, { ...params, tab });
	if (result?.tab !== undefined) {
		if (result.tab === null) last.delete(b.id);
		else last.set(b.id, result.tab);
	}
	return result;
}

const CALLS = {
	browsers: async (args) => {
		if (args.reload) {
			const b = await pick(args.browser);
			await request(b, "reload", {}, 5000);
			return text(`Reloaded efferent in ${b.name}; it reconnects in about 2 s.`);
		}
		await pick().catch(() => undefined);
		const all = connected();
		if (!all.length) return text("No browser is connected yet. Install the efferent extension in a Chromium browser (chrome://extensions, Developer mode, Load unpacked) and keep the browser open.");
		const rows = await Promise.all(all.map(async (b) => {
			const s = await request(b, "status", {}, 5000).catch(() => null);
			return `- ${b.name} (${b.id})${s ? `: ${s.paused ? "paused by the person" : "on"}, ${s.calls} calls, ${s.focusChanges} focus changes, ${s.userTabSwitches} switches of the person's tabs, ${s.debuggerAttaches} debugger attaches` : ""}`;
		}));
		return text(rows.join("\n"));
	},
	tabs: async (args) => {
		const rows = await into(args, "tabs");
		return text(rows.map((t) => `- ${t.id}${t.mine ? " (yours)" : ""}${t.front ? " (the person's current tab)" : ""}: ${t.title} | ${t.url}`).join("\n"));
	},
	open: async (args) => text((await into(args, "open", { url: args.url, show: args.show })).text),
	read: async (args) => text((await into(args, "read", { find: args.find, text: args.text, max: args.max })).text),
	act: async (args) => {
		if (!Array.isArray(args.actions) || !args.actions.length) throw new Error("Give actions: a list of steps.");
		return text((await into(args, "act", { actions: args.actions, trusted: args.trusted })).text);
	},
	screenshot: async (args) => {
		const r = await into(args, "shot");
		return { content: [{ type: "image", data: r.data, mimeType: "image/jpeg" }, { type: "text", text: `Tab ${r.tab}.` }] };
	},
	eval: async (args) => text((await into(args, "eval", { js: args.js })).text),
	close: async (args) => text((await into(args, "close")).text),
};

const write = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);

async function handle({ id, method, params }) {
	if (id === undefined) return;
	if (method === "initialize") return write({ jsonrpc: "2.0", id, result: { protocolVersion: params?.protocolVersion ?? "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "efferent", version: VERSION }, instructions: INSTRUCTIONS } });
	if (method === "ping") return write({ jsonrpc: "2.0", id, result: {} });
	if (method === "tools/list") return write({ jsonrpc: "2.0", id, result: { tools: TOOLS } });
	if (method === "tools/call") {
		const call = CALLS[params?.name];
		if (!call) return write({ jsonrpc: "2.0", id, error: { code: -32602, message: `Unknown tool ${params?.name}` } });
		try {
			return write({ jsonrpc: "2.0", id, result: await call(params.arguments ?? {}) });
		} catch (error) {
			return write({ jsonrpc: "2.0", id, result: { ...text(error.message), isError: true } });
		}
	}
	write({ jsonrpc: "2.0", id, error: { code: -32601, message: `Unknown method ${method}` } });
}

if (process.argv[2] === "extension") {
	const to = join(homedir(), ".efferent", "extension");
	cpSync(fileURLToPath(new URL("../extension", import.meta.url)), to, { recursive: true });
	process.stdout.write(`The extension is in ${to}
In your browser open chrome://extensions, turn on Developer mode, click Load unpacked and pick that folder.
`);
	process.exit(0);
}

const port = await listen();
if (!port) process.stderr.write("efferent: every port from 47800 to 47807 is taken, so no browser can connect.\n");

createInterface({ input: process.stdin })
	.on("line", (line) => {
		if (!line.trim()) return;
		let message;
		try {
			message = JSON.parse(line);
		} catch {
			return write({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
		}
		handle(message);
	})
	.on("close", () => process.exit(0));
