import { execFileSync } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";
import { createServer } from "node:http";

import { connect } from "./client.mjs";

const flag = (name, fallback) => process.argv.find((a) => a.startsWith(`--${name}=`))?.split("=")[1] ?? fallback;
const trials = Number(flag("trials", 1));
const only = flag("case", "");
const browser = flag("browser", undefined);
const cases = JSON.parse(readFileSync(new URL("cases.json", import.meta.url))).filter((c) => !only || c.id === only);

const server = createServer((req, res) => {
	const url = new URL(req.url, "http://x");
	if (url.pathname === "/results") return res.writeHead(200, { "content-type": "text/html" }).end(`<!doctype html><title>Results</title><h1>Results for ${url.searchParams.get("q")?.replace(/</g, "&lt;")}</h1>`);
	try {
		const html = readFileSync(new URL(`pages${url.pathname}.html`, import.meta.url));
		const headers = { "content-type": "text/html" };
		if (url.pathname === "/csp") headers["content-security-policy"] = "default-src 'self'; script-src 'self'";
		if (url.pathname === "/tt") headers["content-security-policy"] = "require-trusted-types-for 'script'";
		res.writeHead(200, headers).end(html);
	} catch {
		res.writeHead(404).end("not found");
	}
});
await new Promise((done) => server.listen(0, "127.0.0.1", done));
const base = `http://127.0.0.1:${server.address().port}`;

const front = () => (process.platform === "win32" ? execFileSync("powershell", ["-NoProfile", "-Command", "Add-Type -Name W -Namespace U -MemberDefinition '[DllImport(\"user32.dll\")] public static extern System.IntPtr GetForegroundWindow();'; [U.W]::GetForegroundWindow()"]).toString().trim() : "");
const counts = async (mcp) => {
	const t = (await mcp.call("browsers")).text;
	const n = (label) => Number(t.match(new RegExp(`(\\d+) ${label}`))?.[1] ?? 0);
	return { focus: n("focus changes"), tabs: n("switches of the person's tabs"), debugger: n("debugger attaches") };
};

function resolve(actions, page) {
	return actions.map((a) => {
		const out = { ...a };
		for (const key of ["click", "fill", "hover"]) {
			if (typeof a[key] !== "string" || !a[key].startsWith("ref:")) continue;
			const name = a[key].slice(4).toLowerCase();
			const line = page.split("\n").find((l) => /^\[[\d:]+\]/.test(l) && l.toLowerCase().includes(`"${name}`));
			if (!line) throw new Error(`No ref for "${name}" in the page.`);
			out[key] = line.match(/^\[([\d:]+)\]/)[1];
		}
		return out;
	});
}

const mcp = connect();
const who = (await mcp.call("browsers")).text.split("\n")[0];
console.log(`${who}\n${cases.length} cases x ${trials} trials on ${base}\n`);
const rows = [];
const start = await counts(mcp);

for (let trial = 1; trial <= trials; trial++) {
	for (const c of cases) {
		const before = front();
		const was = await counts(mcp);
		const t0 = Date.now();
		let pass = false;
		let error = "";
		const tabs = [];
		try {
			const opened = await mcp.call("open", { url: base + c.page, browser });
			tabs.push(Number(opened.text.match(/^Tab (\d+)/)?.[1]));
			const t1 = Date.now();
			if (c.eval) {
				const r = await mcp.call("eval", { js: c.eval, browser });
				pass = r.ok && r.text.split("\n")[0] === c.expect;
				if (!pass) error = r.text.slice(0, 200);
			} else {
				const r = await mcp.call("act", { actions: resolve(c.act, opened.text), browser });
				tabs.push(Number(r.text.match(/\nTab (\d+)/)?.[1]));
				const failed = r.text.split("\n").find((l) => l.startsWith("failed"));
				const check = await mcp.call("eval", { js: c.check, browser });
				pass = r.ok && !failed && check.text === "true";
				if (!pass) error = (failed ?? check.text).slice(0, 200);
			}
			rows.push({ id: c.id, trial, pass, ms: Date.now() - t1, error });
		} catch (e) {
			rows.push({ id: c.id, trial, pass, ms: Date.now() - t0, error: e.message.slice(0, 200) });
		}
		const now = await counts(mcp);
		Object.assign(rows.at(-1), { stole: before !== front(), focus: now.focus - was.focus, tabs: now.tabs - was.tabs, debugger: now.debugger - was.debugger });
		for (const tab of new Set(tabs.filter(Boolean))) await mcp.call("close", { tab, browser }).catch(() => undefined);
		const r = rows.at(-1);
		console.log(`${r.pass ? "pass" : "FAIL"}  ${c.id.padEnd(11)} ${String(r.ms).padStart(5)} ms${r.stole || r.focus || r.tabs ? "  INTERRUPTED" : ""}${r.debugger ? "  (debugger)" : ""}${r.error ? `  ${r.error}` : ""}`);
	}
}

const end = await counts(mcp);
mcp.close();
server.closeAllConnections();
server.close();

const ms = rows.map((r) => r.ms).sort((a, b) => a - b);
const passed = rows.filter((r) => r.pass).length;
const summary = {
	at: new Date().toISOString(),
	browser: who.match(/^- (.+?) \(/)?.[1] ?? who,
	cases: cases.length,
	trials,
	passed,
	of: rows.length,
	medianMs: ms[Math.floor(ms.length / 2)],
	p90Ms: ms[Math.floor(ms.length * 0.9)],
	foregroundStolen: rows.filter((r) => r.stole).length,
	browserFocusChanges: end.focus - start.focus,
	personTabSwitches: end.tabs - start.tabs,
	debuggerAttaches: end.debugger - start.debugger,
	failed: rows.filter((r) => !r.pass).map((r) => `${r.id}#${r.trial}: ${r.error}`),
};
console.log(`\n${passed} of ${rows.length} passed. Median ${summary.medianMs} ms, p90 ${summary.p90Ms} ms.`);
console.log(`Interruptions: ${summary.foregroundStolen} foreground steals, ${summary.browserFocusChanges} browser focus changes, ${summary.personTabSwitches} switches of the person's tabs. Debugger attached ${summary.debuggerAttaches} times (trusted steps only).`);
if (!only && !process.env.DRY) appendFileSync(new URL("runs.jsonl", import.meta.url), `${JSON.stringify(summary)}\n`);
