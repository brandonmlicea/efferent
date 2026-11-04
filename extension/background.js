const PORTS = Array.from({ length: 8 }, (_, i) => 47800 + i);
const sockets = new Map();
const stats = { calls: 0, focusChanges: 0, userTabSwitches: 0, debuggerAttaches: 0 };
let busy = 0;
let raising = false;

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const local = chrome.storage.local;
const KEYS = { Enter: 13, Tab: 9, Escape: 27, Backspace: 8, Delete: 46, Space: 32, " ": 32, ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40, Home: 36, End: 35, PageUp: 33, PageDown: 34 };

function guessName() {
	if (navigator.brave) return "Brave";
	const brands = (navigator.userAgentData?.brands ?? []).map((b) => b.brand);
	return ["Microsoft Edge", "Opera", "Thorium", "Vivaldi", "Google Chrome", "Chromium"].find((b) => brands.includes(b)) ?? "Chromium";
}

async function me() {
	let { id, name } = await local.get(["id", "name"]);
	if (!id) {
		id = crypto.randomUUID().slice(0, 8);
		await local.set({ id });
	}
	return { id, name: name || guessName(), version: chrome.runtime.getManifest().version };
}

const open = () => [...sockets.values()].filter((ws) => ws.readyState === WebSocket.OPEN);

async function badge() {
	const { paused } = await local.get("paused");
	await chrome.action.setBadgeBackgroundColor({ color: paused ? "#8a8a8a" : "#2563eb" });
	await chrome.action.setBadgeText({ text: paused ? "off" : busy ? "•" : "" });
	await chrome.action.setTitle({ title: paused ? "efferent: paused" : `efferent: ${open().length ? `connected to ${open().length} MCP server${open().length > 1 ? "s" : ""}` : "waiting for an MCP server"}` });
}

function dial() {
	chrome.runtime.getPlatformInfo();
	for (const port of PORTS) {
		if (sockets.has(port)) continue;
		const ws = new WebSocket(`ws://127.0.0.1:${port}`);
		sockets.set(port, ws);
		let beat;
		ws.onopen = async () => {
			ws.send(JSON.stringify({ hello: await me() }));
			beat = setInterval(() => ws.send('{"ping":1}'), 20000);
			badge();
		};
		ws.onmessage = (e) => answer(ws, JSON.parse(e.data));
		ws.onclose = () => {
			clearInterval(beat);
			sockets.delete(port);
			badge();
		};
	}
}

async function fronts() {
	const own = await mine();
	return new Map((await chrome.tabs.query({ active: true })).filter((t) => t.windowId !== own).map((t) => [t.windowId, t.id]));
}

async function answer(ws, { id, method, params }) {
	if (!id) return;
	const before = await fronts();
	busy++;
	stats.calls++;
	badge();
	try {
		if ((await local.get("paused")).paused && method !== "status") throw new Error("The person paused efferent in this browser. Ask them to turn it back on from its toolbar button.");
		if (!METHODS[method]) throw new Error(`Unknown method ${method}.`);
		ws.send(JSON.stringify({ id, result: await METHODS[method](params ?? {}) }));
	} catch (error) {
		ws.send(JSON.stringify({ id, error: String(error?.message ?? error) }));
	} finally {
		for (const [win, tab] of await fronts()) if (before.has(win) && before.get(win) !== tab) stats.userTabSwitches++;
		busy--;
		badge();
	}
}

async function mine() {
	const { agentWindow } = await chrome.storage.session.get("agentWindow");
	if (agentWindow == null) return null;
	return chrome.windows.get(agentWindow).then(() => agentWindow, () => null);
}

const address = (url) => (/^[a-z][\w+.-]*:/i.test(url) ? url : `https://${url}`);

async function backTab(windowId, url, openerTabId) {
	const tab = await chrome.tabs.create({ windowId, url, active: false, openerTabId });
	await chrome.tabs.update(tab.id, { active: true });
	return tab;
}

async function newTab(url, show) {
	const id = await mine();
	if (id != null) {
		const tab = await backTab(id, url);
		if (show) await chrome.windows.update(id, { state: "normal", focused: true });
		return tab;
	}
	const front = await chrome.windows.getLastFocused().catch(() => null);
	const win = await chrome.windows.create({ url, focused: !!show, width: 1280, height: 900 });
	if (!show && front?.focused) {
		raising = true;
		await chrome.windows.update(front.id, { focused: true });
		setTimeout(() => (raising = false), 300);
	}
	await chrome.storage.session.set({ agentWindow: win.id });
	return win.tabs[0];
}

async function call(tabId, frame, fn, ...args) {
	const target = frame === "all" ? { tabId, allFrames: true } : { tabId, frameIds: [frame] };
	await chrome.scripting.executeScript({ target, files: ["kit.js"] });
	const out = await chrome.scripting.executeScript({
		target,
		args: [fn, args],
		func: async (n, a) => {
			try {
				return { ok: await globalThis.__eff[n](...a) };
			} catch (e) {
				return { err: String(e?.message ?? e) };
			}
		},
	});
	if (frame === "all") return out;
	const r = out[0]?.result;
	if (!r) throw new Error("The page did not answer.");
	if (r.err) throw new Error(r.err);
	return r.ok;
}

async function settle(tabId) {
	await sleep(150);
	const start = Date.now();
	while (Date.now() - start < 20000) {
		const tab = await chrome.tabs.get(tabId).catch(() => null);
		if (!tab || tab.status === "complete") break;
		await sleep(100);
	}
	await call(tabId, 0, "quiet", 250, 1500).catch(() => undefined);
}

async function look(tabId, o = {}) {
	const tab = await chrome.tabs.get(tabId);
	const head = `Tab ${tabId}${tab.windowId === (await mine()) ? "" : " (in the person's own window)"}: ${tab.title}\n${tab.url}`;
	let frames;
	try {
		frames = await call(tabId, "all", "snap", o);
	} catch {
		frames = await call(tabId, 0, "snap", o).then((ok) => [{ frameId: 0, result: { ok } }], (e) => e);
		if (frames instanceof Error) return `${head}\nThis page cannot be read by extensions (${frames.message}).`;
	}
	const main = frames.find((f) => f.frameId === 0)?.result?.ok;
	let more = 0;
	const lines = [];
	for (const f of frames) {
		const snap = f.result?.ok;
		if (!snap) continue;
		more += snap.more;
		for (const [n, l] of snap.elements) {
			if (lines.length < (o.max ?? 150)) lines.push(`[${f.frameId ? `${f.frameId}:${n}` : n}] ${l}`);
			else more++;
		}
	}
	return [
		head,
		main ? `Scrolled ${main.y} of ${Math.max(0, main.h - main.vh)} px.` : "",
		lines.length ? `Elements:\n${lines.join("\n")}` : o.find ? `No elements match "${o.find}".` : "No interactive elements.",
		more ? `${more} more elements: read with find to narrow them.` : "",
		main?.text ? `Text:\n${main.text}` : "",
	].filter(Boolean).join("\n");
}

function aim(value) {
	const m = String(value).match(/^(?:(\d+):)?(\d+)$/);
	if (m) return { frame: Number(m[1] ?? 0), target: { ref: Number(m[2]) } };
	if (String(value).startsWith("css:")) return { frame: 0, target: { css: String(value).slice(4) } };
	return { frame: 0, target: { text: String(value) } };
}

async function debug(tabId) {
	const target = { tabId };
	await chrome.debugger.attach(target, "1.3");
	stats.debuggerAttaches++;
	const send = (method, params) => chrome.debugger.sendCommand(target, method, params);
	await send("Emulation.setFocusEmulationEnabled", { enabled: true }).catch(() => undefined);
	return { send, done: () => chrome.debugger.detach(target).catch(() => undefined) };
}

async function withDebugger(tabId, fn) {
	const d = await debug(tabId);
	try {
		return await fn(d.send);
	} finally {
		await d.done();
	}
}

async function keys(send, combo) {
	const parts = String(combo).split("+");
	const key = parts.pop();
	const mods = parts.map((p) => p.toLowerCase());
	const modifiers = (mods.includes("alt") ? 1 : 0) | (mods.includes("ctrl") ? 2 : 0) | (mods.includes("meta") || mods.includes("cmd") ? 4 : 0) | (mods.includes("shift") ? 8 : 0);
	const code = KEYS[key] ?? key.toUpperCase().charCodeAt(0);
	const text = key === "Enter" ? "\r" : key.length === 1 && !(modifiers & 6) ? key : undefined;
	await send("Input.dispatchKeyEvent", { type: text ? "keyDown" : "rawKeyDown", key, windowsVirtualKeyCode: code, modifiers, text });
	await send("Input.dispatchKeyEvent", { type: "keyUp", key, windowsVirtualKeyCode: code, modifiers });
}

async function step(state, a, trusted) {
	const tab = state.tab;
	if (a.go) return void (await chrome.tabs.update(tab, { url: address(a.go) }));
	if (a.back) return void (await chrome.tabs.goBack(tab));
	if (a.forward) return void (await chrome.tabs.goForward(tab));
	if (a.reload) return void (await chrome.tabs.reload(tab));
	if (a.wait != null) {
		if (typeof a.wait === "number") return void (await sleep(Math.min(a.wait, 30000)));
		const start = Date.now();
		while (!(await call(tab, 0, "has", a.wait).catch(() => false))) {
			if (Date.now() - start > (a.timeout ?? 15000)) throw new Error(`"${a.wait}" did not appear.`);
			await sleep(250);
		}
		return `"${a.wait}" is on the page`;
	}
	if (a.scroll != null) {
		const { frame, target } = typeof a.scroll === "number" ? { frame: 0 } : aim(a.scroll);
		return (await call(tab, frame, "scroll", typeof a.scroll === "number" ? a.scroll : 0, target)).said;
	}
	if (trusted && (a.click != null || a.type != null || a.press != null)) {
		const d = await state.debugger();
		if (a.type != null) return void (await d.send("Input.insertText", { text: String(a.type) }));
		if (a.press != null) return void (await keys(d.send, a.press));
		const { x, y, said } = await call(tab, 0, "point", aim(a.click).target);
		for (const type of ["mouseMoved", "mousePressed", "mouseReleased"]) await d.send("Input.dispatchMouseEvent", { type, x, y, button: "left", clickCount: 1 });
		return `clicked ${said} (trusted)`;
	}
	if (a.click != null) {
		const { frame, target } = aim(a.click);
		const r = await call(tab, frame, "click", target);
		if (!r.open) return r.said;
		const t = await backTab((await chrome.tabs.get(tab)).windowId, r.open, tab);
		state.tab = t.id;
		return `the link opens a new tab: now in tab ${t.id}`;
	}
	if (a.fill != null) {
		const { frame, target } = aim(a.fill);
		return (await call(tab, frame, "fill", target, a.value)).said;
	}
	if (a.hover != null) {
		const { frame, target } = aim(a.hover);
		return (await call(tab, frame, "hover", target)).said;
	}
	if (a.type != null) return (await call(tab, 0, "type", String(a.type))).said;
	if (a.press != null) return (await call(tab, 0, "press", a.press)).said;
	throw new Error("Unknown action.");
}

async function capture(windowId) {
	const url = await chrome.tabs.captureVisibleTab(windowId, { format: "jpeg", quality: 70 });
	return url.slice(url.indexOf(",") + 1);
}

async function evaluate(tabId, js) {
	const [r] = await chrome.scripting.executeScript({
		target: { tabId },
		world: "MAIN",
		args: [js],
		func: async (code) => {
			try {
				let v = (0, eval)(code);
				if (v && typeof v.then === "function") v = await v;
				return { ok: v === undefined ? "undefined" : typeof v === "string" ? v : (JSON.stringify(v) ?? String(v)) };
			} catch (e) {
				return { err: String(e?.message ?? e) };
			}
		},
	});
	const res = r?.result;
	if (res && !("err" in res)) return res.ok;
	if (!/unsafe-eval|Content Security Policy|EvalError|Trusted ?(Type|Script)/i.test(res?.err ?? "")) throw new Error(res?.err ?? "The page did not answer.");
	const code = `(async () => { try { let v = (0, eval)(${JSON.stringify(js)}); if (v && typeof v.then === "function") v = await v; return { ok: v === undefined ? "undefined" : typeof v === "string" ? v : (JSON.stringify(v) ?? String(v)) }; } catch (e) { return { err: String(e?.message ?? e) }; } })()`;
	const users = await chrome.userScripts?.getScripts().then(() => true, () => false);
	if (users) {
		await chrome.userScripts.configureWorld({ worldId: "efferent", csp: "script-src 'self' 'unsafe-eval'" });
		const [u] = await chrome.userScripts.execute({ target: { tabId }, js: [{ code }], world: "USER_SCRIPT", worldId: "efferent" });
		if (u?.result?.err) throw new Error(u.result.err);
		if (u?.result) return `${u.result.ok}\n(The page blocks eval, so this ran beside it: the DOM is shared, the page's own variables are not.)`;
	}
	const out = await withDebugger(tabId, (send) => send("Runtime.evaluate", { expression: js, awaitPromise: true, returnByValue: true }));
	if (out.exceptionDetails) throw new Error(out.exceptionDetails.exception?.description ?? out.exceptionDetails.text);
	const v = out.result?.value;
	return v === undefined ? "undefined" : typeof v === "string" ? v : JSON.stringify(v);
}

const METHODS = {
	status: async () => ({ ...(await me()), ...stats, agentWindow: await mine(), paused: !!(await local.get("paused")).paused }),
	tabs: async () => {
		const [tabs, front, own] = await Promise.all([chrome.tabs.query({}), chrome.windows.getLastFocused().catch(() => null), mine()]);
		return tabs.map((t) => ({ id: t.id, window: t.windowId, title: t.title, url: t.url, active: t.active, mine: t.windowId === own, front: t.active && t.windowId === front?.id && t.windowId !== own }));
	},
	open: async ({ url, tab, show }) => {
		const t = tab ? await chrome.tabs.update(tab, { url: address(url) }) : await newTab(address(url), show);
		await settle(t.id);
		return { tab: t.id, text: await look(t.id) };
	},
	read: async ({ tab, find, text, max }) => ({ tab, text: await look(tab, { find, text, max }) }),
	act: async ({ tab, actions, trusted }) => {
		const state = { tab, attached: null };
		state.debugger = async () => (state.attached ??= await debug(state.tab));
		const log = [];
		try {
			for (const a of actions) {
				try {
					const said = await step(state, a, trusted || a.trusted);
					log.push(`ok ${JSON.stringify(a)}${said ? `: ${said}` : ""}`);
				} catch (error) {
					log.push(`failed ${JSON.stringify(a)}: ${error.message}`);
					break;
				}
				await settle(state.tab);
			}
		} finally {
			await state.attached?.done();
		}
		return { tab: state.tab, text: `${log.join("\n")}\n\n${await look(state.tab)}` };
	},
	shot: async ({ tab }) => {
		const t = await chrome.tabs.get(tab);
		const win = await chrome.windows.get(t.windowId);
		if (t.windowId === (await mine())) {
			if (!t.active) await chrome.tabs.update(tab, { active: true });
			if (win.state === "minimized") {
				await chrome.windows.update(win.id, { state: "normal", focused: false });
				await sleep(350);
				try {
					return { tab, data: await capture(win.id) };
				} finally {
					await chrome.windows.update(win.id, { state: "minimized" });
				}
			}
		}
		if (t.active && win.state !== "minimized") return { tab, data: await capture(win.id) };
		return { tab, data: (await withDebugger(tab, (send) => send("Page.captureScreenshot", { format: "jpeg", quality: 70 }))).data };
	},
	eval: async ({ tab, js }) => ({ tab, text: await evaluate(tab, js) }),
	reload: async () => {
		setTimeout(() => chrome.runtime.reload(), 100);
		return "Reloading.";
	},
	close: async ({ tab }) => {
		const t = await chrome.tabs.get(tab);
		const last = t.windowId === (await mine()) && (await chrome.tabs.query({ windowId: t.windowId })).length === 1;
		await (last ? chrome.tabs.update(tab, { url: "about:blank" }) : chrome.tabs.remove(tab));
		return { tab: null, text: `Closed tab ${tab}.` };
	},
};

chrome.windows.onFocusChanged.addListener((id) => {
	if (busy && !raising && id !== chrome.windows.WINDOW_ID_NONE) stats.focusChanges++;
});
chrome.storage.onChanged.addListener(async (change) => {
	if (change.name) for (const ws of open()) ws.send(JSON.stringify({ hello: await me() }));
	badge();
});
chrome.runtime.onMessage.addListener((message, _sender, reply) => {
	if (message === "state") me().then(async (who) => reply({ ...who, ...stats, servers: open().length, paused: !!(await local.get("paused")).paused }));
	return true;
});
chrome.alarms.create("dial", { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener(dial);
setInterval(dial, 2000);
dial();
badge();
