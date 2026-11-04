import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

export function connect() {
	const server = spawn(process.execPath, [fileURLToPath(new URL("../src/index.js", import.meta.url))], { stdio: ["pipe", "pipe", "inherit"] });
	const waiting = new Map();
	let seq = 0;
	createInterface({ input: server.stdout }).on("line", (line) => {
		const m = JSON.parse(line);
		waiting.get(m.id)?.(m);
		waiting.delete(m.id);
	});
	const send = (method, params) =>
		new Promise((done) => {
			const id = ++seq;
			waiting.set(id, done);
			server.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
		});
	const ready = send("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "efferent-eval", version: "1" } });
	return {
		async call(name, args = {}) {
			await ready;
			const m = await send("tools/call", { name, arguments: args });
			if (m.error) throw new Error(m.error.message);
			const text = m.result.content.filter((c) => c.type === "text").map((c) => c.text).join("\n");
			const image = m.result.content.find((c) => c.type === "image")?.data;
			return { ok: !m.result.isError, text, image };
		},
		close: () => server.kill(),
	};
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	const mcp = connect();
	for (const arg of process.argv.slice(2)) {
		const at = arg.indexOf(" ");
		const r = await mcp.call(at < 0 ? arg : arg.slice(0, at), at < 0 ? {} : JSON.parse(arg.slice(at + 1)));
		console.log(`${r.ok ? "" : "ERROR "}${r.text}${r.image ? `\n[image ${r.image.length} b64 chars]` : ""}\n---`);
	}
	mcp.close();
}
