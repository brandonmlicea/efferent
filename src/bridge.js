import { createHash } from "node:crypto";
import { createServer } from "node:http";

export const PORTS = Array.from({ length: 8 }, (_, i) => 47800 + i);
export const EXTENSION_ID = process.env.EFFERENT_EXTENSION_ID || "djkbgokjopagggpagplncnbanmpanhlh";

const browsers = new Map();
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
let seq = 0;

function frame(payload, op = 1) {
	const n = payload.length;
	const head = n < 126 ? Buffer.from([0x80 | op, n]) : n < 65536 ? Buffer.alloc(4) : Buffer.alloc(10);
	if (n >= 126 && n < 65536) {
		head[0] = 0x80 | op;
		head[1] = 126;
		head.writeUInt16BE(n, 2);
	} else if (n >= 65536) {
		head[0] = 0x80 | op;
		head[1] = 127;
		head.writeBigUInt64BE(BigInt(n), 2);
	}
	return Buffer.concat([head, payload]);
}

function frames(socket, onText) {
	let chunks = [];
	let size = 0;
	let parts = [];
	socket.on("data", (chunk) => {
		chunks.push(chunk);
		size += chunk.length;
		for (;;) {
			if (size < 2) return;
			let buf = chunks.length > 1 ? Buffer.concat(chunks) : chunks[0];
			chunks = [buf];
			let len = buf[1] & 127;
			let at = 2;
			if (len === 126) {
				if (size < 4) return;
				len = buf.readUInt16BE(2);
				at = 4;
			} else if (len === 127) {
				if (size < 10) return;
				len = Number(buf.readBigUInt64BE(2));
				at = 10;
			}
			const masked = buf[1] & 128;
			if (size < at + (masked ? 4 : 0) + len) return;
			const mask = masked ? buf.subarray(at, at + 4) : null;
			if (masked) at += 4;
			const op = buf[0] & 15;
			const fin = buf[0] & 128;
			const data = Buffer.from(buf.subarray(at, at + len));
			if (mask) for (let i = 0; i < data.length; i++) data[i] ^= mask[i & 3];
			buf = buf.subarray(at + len);
			chunks = buf.length ? [buf] : [];
			size = buf.length;
			if (op === 8) return void socket.end(frame(Buffer.alloc(0), 8));
			if (op === 9) socket.write(frame(data, 10));
			if (op > 2) continue;
			parts.push(data);
			if (fin) {
				onText(Buffer.concat(parts).toString("utf8"));
				parts = [];
			}
		}
	});
}

function attach(socket) {
	const b = { id: null, name: "", at: 0, pending: new Map(), send: (m) => socket.write(frame(Buffer.from(JSON.stringify(m)))) };
	frames(socket, (text) => {
		const m = JSON.parse(text);
		if (m.hello) {
			Object.assign(b, m.hello, { at: b.at || Date.now() });
			browsers.set(b.id, b);
			return;
		}
		const p = b.pending.get(m.id);
		if (!p) return;
		b.pending.delete(m.id);
		if (m.error) p.reject(new Error(m.error));
		else p.resolve(m.result);
	});
	socket.on("error", () => undefined);
	socket.on("close", () => {
		if (browsers.get(b.id) === b) browsers.delete(b.id);
		for (const p of b.pending.values()) p.reject(new Error(`${b.name} disconnected.`));
	});
}

export function listen() {
	return new Promise((resolve) => {
		const tryPort = (i) => {
			if (i >= PORTS.length) return resolve(null);
			const server = createServer((_req, res) => res.writeHead(426).end("efferent: connect with the browser extension.\n"));
			server.on("upgrade", (req, socket) => {
				const host = String(req.headers.host ?? "").replace(/:\d+$/, "");
				if (req.headers.origin !== `chrome-extension://${EXTENSION_ID}` || !["127.0.0.1", "localhost"].includes(host)) return void socket.end("HTTP/1.1 403 Forbidden\r\n\r\n");
				const accept = createHash("sha1").update(`${req.headers["sec-websocket-key"]}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64");
				socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
				socket.setNoDelay(true);
				attach(socket);
			});
			server.once("error", () => tryPort(i + 1));
			server.listen(PORTS[i], "127.0.0.1", () => resolve(PORTS[i]));
		};
		tryPort(0);
	});
}

export const connected = () => [...browsers.values()];

export async function pick(name = process.env.EFFERENT_BROWSER) {
	for (let i = 0; i < 80 && !browsers.size; i++) await sleep(100);
	const all = connected().sort((a, b) => a.at - b.at);
	if (!all.length) throw new Error("No browser is connected. Open a Chromium browser with the efferent extension installed (chrome://extensions, Developer mode, Load unpacked, the extension folder) and make sure it is switched on in its toolbar button.");
	if (!name) return all[0];
	const want = name.toLowerCase();
	const found = all.find((b) => b.id === name || b.name.toLowerCase() === want) ?? all.find((b) => b.name.toLowerCase().includes(want));
	if (!found) throw new Error(`No connected browser is named "${name}". Connected: ${all.map((b) => b.name).join(", ")}.`);
	return found;
}

export function request(b, method, params, ms = 120000) {
	const id = `${++seq}`;
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			b.pending.delete(id);
			reject(new Error(`${b.name} took longer than ${ms / 1000} s.`));
		}, ms);
		b.pending.set(id, {
			resolve: (v) => (clearTimeout(timer), resolve(v)),
			reject: (e) => (clearTimeout(timer), reject(e)),
		});
		b.send({ id, method, params });
	});
}
