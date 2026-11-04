(() => {
	if (globalThis.__eff) return;
	const refs = new Map();
	const ids = new WeakMap();
	let next = 1;
	const SEL = 'a[href],button,input:not([type=hidden]),select,textarea,summary,[role=button],[role=link],[role=checkbox],[role=radio],[role=switch],[role=tab],[role=menuitem],[role=menuitemcheckbox],[role=option],[role=combobox],[role=textbox],[role=searchbox],[role=slider],[contenteditable=""],[contenteditable=true],[onclick]';
	const CHROME = "nav,header,footer,aside,[role=navigation],[role=banner],[role=contentinfo],[role=complementary]";
	const KINDS = { checkbox: "checkbox", radio: "radio", submit: "button", button: "button", reset: "button", image: "button", range: "slider", file: "file", search: "searchbox" };

	function* walk(root) {
		for (const el of root.querySelectorAll("*")) {
			yield el;
			if (el.shadowRoot) yield* walk(el.shadowRoot);
		}
	}
	const squash = (s, n = 80) => (s || "").replace(/\s+/g, " ").trim().slice(0, n);
	const fire = (el, type) => el.dispatchEvent(new Event(type, { bubbles: true, composed: true }));
	const pause = (ms) => new Promise((done) => setTimeout(done, ms));

	function shown(el) {
		const r = el.getBoundingClientRect();
		if (r.width < 1 || r.height < 1) return false;
		return el.checkVisibility ? el.checkVisibility({ visibilityProperty: true }) : true;
	}
	const reachable = (el) => shown(el) || (el.labels?.length > 0 && shown(el.labels[0]));

	function kind(el) {
		const role = el.getAttribute("role");
		if (role) return role;
		const tag = el.tagName.toLowerCase();
		if (tag === "a") return "link";
		if (tag === "input") return KINDS[el.type] || "textbox";
		if (tag === "textarea") return "textbox";
		if (tag === "select") return "select";
		if (tag === "button" || tag === "summary") return "button";
		return el.isContentEditable ? "editor" : "clickable";
	}

	function name(el) {
		const by = el.getAttribute("aria-labelledby");
		const root = el.getRootNode();
		const labelled = by && by.split(/\s+/).map((id) => root.getElementById?.(id)?.innerText).filter(Boolean).join(" ");
		const button = el.tagName === "INPUT" && ["submit", "button", "reset"].includes(el.type) ? el.value : "";
		const labels = el.labels?.length ? [...el.labels].map((l) => l.innerText).join(" ") : "";
		return squash(el.getAttribute("aria-label") || labelled || labels || button || el.innerText || el.getAttribute("placeholder") || el.getAttribute("title") || el.querySelector?.("img[alt]")?.alt || el.getAttribute("alt") || el.getAttribute("name") || "");
	}

	function ref(el) {
		if (!ids.has(el)) {
			ids.set(el, next);
			refs.set(next, new WeakRef(el));
			next++;
		}
		return ids.get(el);
	}

	function where(href) {
		try {
			const u = new URL(href, location.href);
			if (u.protocol === "javascript:") return "";
			const path = u.pathname + (u.search.length <= 40 ? u.search : "?…");
			return squash(u.origin === location.origin ? path : u.origin + path, 90);
		} catch {
			return "";
		}
	}

	function line(el) {
		const k = kind(el);
		let s = `${k} "${name(el)}"`;
		if (k === "link" && el.href) s += ` -> ${where(el.getAttribute("href"))}`;
		if (el instanceof HTMLSelectElement) s += ` = "${squash(el.selectedOptions[0]?.text, 40)}" of ${[...el.options].slice(0, 12).map((o) => squash(o.text, 30)).join(" | ")}${el.options.length > 12 ? " | …" : ""}`;
		else if ((el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) && !["checkbox", "radio", "submit", "button", "reset", "image"].includes(el.type) && el.value) s += ` = "${el.type === "password" ? "••••" : squash(el.value, 60)}"`;
		else if (el.isContentEditable && el.innerText.trim()) s += ` = "${squash(el.innerText, 60)}"`;
		if (el.checked || el.getAttribute("aria-checked") === "true" || el.getAttribute("aria-selected") === "true") s += " (checked)";
		if (el.disabled || el.getAttribute("aria-disabled") === "true") s += " (disabled)";
		return s;
	}

	function snap(o = {}) {
		const wants = String(o.find || "").toLowerCase().split("|").map((a) => a.split(/\s+/).filter(Boolean)).filter((a) => a.length);
		const hit = (s) => wants.some((a) => a.every((w) => s.toLowerCase().includes(w)));
		const max = o.max ?? 150;
		const main = [];
		const aside = [];
		for (const el of walk(document)) {
			if (!el.matches(SEL) || !reachable(el)) continue;
			const l = line(el);
			if (wants.length && !hit(l)) continue;
			const field = el.matches("input,select,textarea,[role=searchbox],[role=combobox]");
			(!field && el.closest(CHROME) ? aside : main).push([el, l]);
		}
		const named = new Set(main.concat(aside).filter(([el, l]) => el.href && !l.startsWith(`${kind(el)} ""`)).map(([el]) => el.href));
		const all = main.concat(aside).filter(([el, l]) => !(el.href && l.startsWith(`${kind(el)} ""`) && named.has(el.href)));
		const elements = all.slice(0, max).map(([el, l]) => [ref(el), l]);
		const more = all.length - elements.length;
		let text = "";
		if (o.text || wants.length) {
			const split = (t) => t.split("\n").map((s) => squash(s, 400)).filter(Boolean);
			const skip = new Set();
			for (const c of document.querySelectorAll(CHROME)) if (!c.parentElement?.closest(CHROME)) for (const l of split(c.innerText)) skip.add(l);
			const all = split(document.body?.innerText || "");
			const kept = all.filter((l) => !skip.has(l));
			const lines = kept.length > 20 ? kept : all;
			const keep = new Set();
			lines.forEach((s, i) => {
				if (!wants.length) keep.add(i);
				else if (hit(s)) for (let j = Math.max(0, i - 2); j <= Math.min(lines.length - 1, i + 3); j++) keep.add(j);
			});
			text = [...keep].sort((a, b) => a - b).map((i) => lines[i]).join("\n");
			const chars = o.chars ?? 6000;
			if (text.length > chars) text = `${text.slice(0, chars)}\n… ${text.length - chars} more characters (scroll, or read with find)`;
		}
		return { elements, more, text, y: Math.round(scrollY), h: document.documentElement.scrollHeight, vh: innerHeight };
	}

	function element(t) {
		if (t.ref != null) {
			const el = refs.get(t.ref)?.deref();
			if (!el || !el.isConnected) throw new Error(`Ref ${t.ref} is gone: the page changed. Read the page again.`);
			return el;
		}
		if (t.css) {
			for (const root of [document, ...[...walk(document)].filter((e) => e.shadowRoot).map((e) => e.shadowRoot)]) {
				const el = root.querySelector(t.css);
				if (el) return el;
			}
			throw new Error(`Nothing matches ${t.css}.`);
		}
		const want = squash(t.text, 200).toLowerCase();
		let near = null;
		for (const el of walk(document)) {
			if (!el.matches(SEL) || !reachable(el)) continue;
			const n = name(el).toLowerCase();
			if (n === want) return el;
			if (!near && n.includes(want)) near = el;
		}
		if (near) return near;
		throw new Error(`No element named "${t.text}" on the page.`);
	}

	function setValue(el, value) {
		const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
		Object.getOwnPropertyDescriptor(proto, "value").set.call(el, value);
	}

	function focused() {
		let el = document.activeElement;
		while (el?.shadowRoot?.activeElement) el = el.shadowRoot.activeElement;
		return el && el !== document.body ? el : null;
	}

	function press(el, opts) {
		const o = { bubbles: true, cancelable: true, composed: true, clientX: opts.x, clientY: opts.y, button: 0, view: window };
		for (const type of opts.types) {
			const Kind = type.startsWith("pointer") ? PointerEvent : MouseEvent;
			el.dispatchEvent(new Kind(type, { ...o, pointerId: 1, isPrimary: true, pointerType: "mouse" }));
		}
	}

	function center(el) {
		el.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
		const r = el.getBoundingClientRect();
		return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
	}

	globalThis.__eff = {
		snap,
		click(t) {
			const el = element(t);
			const link = el.closest("a[href]");
			if (link && link.target === "_blank" && where(link.getAttribute("href"))) return { open: link.href };
			const at = center(el);
			press(el, { ...at, types: ["pointerover", "pointerenter", "mouseover", "pointerdown", "mousedown"] });
			el.focus?.({ preventScroll: true });
			press(el, { ...at, types: ["pointerup", "mouseup"] });
			el.click();
			return { said: `clicked ${line(el)}` };
		},
		hover(t) {
			const el = element(t);
			press(el, { ...center(el), types: ["pointerover", "pointerenter", "mouseover", "mouseenter", "pointermove", "mousemove"] });
			return { said: `hovered ${line(el)}` };
		},
		fill(t, value) {
			const el = element(t);
			el.scrollIntoView({ block: "center", behavior: "instant" });
			if (el instanceof HTMLSelectElement) {
				const want = String(value).trim().toLowerCase();
				const options = [...el.options];
				const o = options.find((x) => x.value.toLowerCase() === want || x.text.trim().toLowerCase() === want) || options.find((x) => x.text.toLowerCase().includes(want));
				if (!o) throw new Error(`No option "${value}". Options: ${options.map((x) => squash(x.text, 40)).join(" | ")}`);
				setValue(el, o.value);
				fire(el, "input");
				fire(el, "change");
				return { said: `chose "${squash(o.text)}"` };
			}
			const toggle = el.type === "checkbox" || el.type === "radio" || ["checkbox", "radio", "switch", "menuitemcheckbox"].includes(el.getAttribute("role"));
			if (toggle) {
				const on = value === true || /^(true|on|yes|1|checked)$/i.test(String(value));
				const now = el.checked ?? el.getAttribute("aria-checked") === "true";
				if (now !== on) this.click(t);
				return { said: on ? `checked ${line(el)}` : `unchecked ${line(el)}` };
			}
			const text = String(value ?? "");
			el.focus({ preventScroll: true });
			if (el.isContentEditable) {
				getSelection().selectAllChildren(el);
				document.execCommand("insertText", false, text);
				if (el.innerText.trim() !== text.trim()) {
					el.textContent = text;
					fire(el, "input");
				}
				return { said: `filled ${line(el)}` };
			}
			if (el.type === "file") throw new Error("A file field needs a file the person picks.");
			setValue(el, text);
			el.dispatchEvent(new InputEvent("input", { bubbles: true, composed: true, inputType: "insertText", data: text }));
			fire(el, "change");
			return { said: `filled ${line(el)}` };
		},
		type(text) {
			const el = focused();
			if (!el) throw new Error("Nothing is focused to type into: fill a field, or click it first.");
			if (el.isContentEditable) document.execCommand("insertText", false, text);
			else if ("value" in el) {
				setValue(el, el.value + text);
				el.dispatchEvent(new InputEvent("input", { bubbles: true, composed: true, inputType: "insertText", data: text }));
			} else throw new Error("The focused element does not take text.");
			return { said: `typed into ${line(el)}` };
		},
		press(combo) {
			const parts = String(combo).split("+");
			const key = parts.pop();
			const mods = parts.map((p) => p.toLowerCase());
			const el = focused() || document.body;
			const init = { key, bubbles: true, cancelable: true, composed: true, ctrlKey: mods.includes("ctrl"), shiftKey: mods.includes("shift"), altKey: mods.includes("alt"), metaKey: mods.includes("meta") || mods.includes("cmd") };
			const go = el.dispatchEvent(new KeyboardEvent("keydown", init));
			if (key.length === 1 || key === "Enter") el.dispatchEvent(new KeyboardEvent("keypress", init));
			el.dispatchEvent(new KeyboardEvent("keyup", init));
			if (!go) return { said: `pressed ${combo}` };
			if (key === "Enter" && el.form && el.tagName !== "TEXTAREA") {
				el.form.requestSubmit();
				return { said: "pressed Enter and submitted the form" };
			}
			if (key.toLowerCase() === "a" && init.ctrlKey && el.select) el.select();
			if (key === "Tab") {
				const all = [...walk(document)].filter((e) => e.tabIndex >= 0 && reachable(e) && !e.disabled);
				const at = all.indexOf(el);
				all[(at + (init.shiftKey ? -1 : 1) + all.length) % all.length]?.focus();
			}
			return { said: `pressed ${combo}` };
		},
		scroll(by, t) {
			if (t) {
				element(t).scrollIntoView({ block: "center", behavior: "instant" });
				return { said: `scrolled to ${line(element(t))}` };
			}
			const before = scrollY;
			scrollBy(0, by);
			if (scrollY === before) {
				const box = [...walk(document)].filter((e) => e.scrollHeight > e.clientHeight + 20 && /(auto|scroll)/.test(getComputedStyle(e).overflowY)).sort((a, b) => b.clientHeight - a.clientHeight)[0];
				if (box) {
					box.scrollBy(0, by);
					return { said: `scrolled a panel to ${Math.round(box.scrollTop)}` };
				}
			}
			return { said: `scrolled to ${Math.round(scrollY)}` };
		},
		point(t) {
			if (window !== top) throw new Error("Trusted steps work on the main frame only.");
			const el = element(t);
			return { ...center(el), said: line(el) };
		},
		has: (text) => (document.body?.innerText || "").toLowerCase().includes(String(text).toLowerCase()),
		async quiet(gap, max) {
			let last = Date.now();
			const watch = new MutationObserver(() => (last = Date.now()));
			watch.observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
			const start = Date.now();
			while (Date.now() - last < gap && Date.now() - start < max) await pause(50);
			watch.disconnect();
			return true;
		},
	};
})();
