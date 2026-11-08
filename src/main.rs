mod bridge;

use base64::Engine;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::io::{BufRead, Write};
use std::path::Path;
use std::sync::{Arc, Mutex};

const INSTRUCTIONS: &str = include_str!("instructions.md");
const TOOLS: &str = include_str!("tools.json");
const EXTENSION: [(&str, &[u8]); 10] = [
    ("manifest.json", include_bytes!("../extension/manifest.json")),
    ("background.js", include_bytes!("../extension/background.js")),
    ("kit.js", include_bytes!("../extension/kit.js")),
    ("popup.html", include_bytes!("../extension/popup.html")),
    ("popup.js", include_bytes!("../extension/popup.js")),
    ("logo.svg", include_bytes!("../extension/logo.svg")),
    ("icon16.png", include_bytes!("../extension/icon16.png")),
    ("icon32.png", include_bytes!("../extension/icon32.png")),
    ("icon48.png", include_bytes!("../extension/icon48.png")),
    ("icon128.png", include_bytes!("../extension/icon128.png")),
];
const MAX_UPLOAD: u64 = 64 << 20;

type Last = Arc<Mutex<HashMap<String, i64>>>;

fn text(s: impl Into<String>) -> Value {
    json!({ "content": [{ "type": "text", "text": s.into() }] })
}

fn mime(path: &Path) -> &'static str {
    match path.extension().and_then(|e| e.to_str()).unwrap_or("").to_lowercase().as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "svg" => "image/svg+xml",
        "pdf" => "application/pdf",
        "txt" | "md" => "text/plain",
        "csv" => "text/csv",
        "json" => "application/json",
        "html" => "text/html",
        "zip" => "application/zip",
        "mp4" => "video/mp4",
        "mov" => "video/quicktime",
        "mp3" => "audio/mpeg",
        "wav" => "audio/wav",
        "docx" => "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "xlsx" => "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "pptx" => "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        _ => "application/octet-stream",
    }
}

fn files(paths: &Value) -> Result<Value, String> {
    let list: Vec<&str> = match paths {
        Value::String(s) => vec![s.as_str()],
        Value::Array(a) => a.iter().filter_map(|v| v.as_str()).collect(),
        _ => return Err("files is a path, or a list of paths, on this computer.".into()),
    };
    let mut out = vec![];
    for p in list {
        let path = Path::new(p);
        let size = std::fs::metadata(path).map_err(|e| format!("{p}: {e}"))?.len();
        if size > MAX_UPLOAD {
            return Err(format!("{p} is {} MB; the most is 64 MB.", size >> 20));
        }
        let data = std::fs::read(path).map_err(|e| format!("{p}: {e}"))?;
        let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("file");
        out.push(json!({ "name": name, "type": mime(path), "data": base64::engine::general_purpose::STANDARD.encode(data) }));
    }
    Ok(Value::Array(out))
}

fn into(last: &Last, args: &Value, method: &str, mut params: Value) -> Result<Value, String> {
    let b = bridge::pick(args["browser"].as_str())?;
    let key = b.id();
    let given = args.get("tab").filter(|t| !t.is_null()).cloned();
    let tab = if method == "open" { given } else { given.or_else(|| last.lock().unwrap().get(&key).map(|t| json!(t))) };
    if ["read", "act", "shot", "eval", "close"].contains(&method) && tab.is_none() {
        return Err("No tab yet: open a page first, or pass a tab from tabs.".into());
    }
    params["tab"] = tab.unwrap_or(Value::Null);
    let r = bridge::request(&b, method, params, 180)?;
    match r.get("tab") {
        Some(Value::Null) => {
            last.lock().unwrap().remove(&key);
        }
        Some(t) if t.is_i64() => {
            last.lock().unwrap().insert(key, t.as_i64().unwrap());
        }
        _ => {}
    }
    Ok(r)
}

fn flag(v: &Value) -> bool {
    v.as_bool() == Some(true)
}

fn browsers(a: &Value) -> Result<Value, String> {
    if flag(&a["reload"]) {
        let b = bridge::pick(a["browser"].as_str())?;
        bridge::request(&b, "reload", json!({}), 5)?;
        return Ok(text(format!("Reloaded efferent in {}; it reconnects in about 2 s.", b.name())));
    }
    let _ = bridge::pick(None);
    let all = bridge::connected();
    if all.is_empty() {
        return Ok(text("No browser is connected yet. Install the efferent extension in a Chromium browser (chrome://extensions, Developer mode, Load unpacked) and keep the browser open."));
    }
    let rows: Vec<String> = all
        .iter()
        .map(|b| {
            let tail = bridge::request(b, "status", json!({}), 5)
                .map(|s| {
                    let on = if flag(&s["paused"]) { "paused by the person" } else { "on" };
                    format!(": {on}, {} calls, {} focus changes, {} switches of the person's tabs, {} debugger attaches", s["calls"], s["focusChanges"], s["userTabSwitches"], s["debuggerAttaches"])
                })
                .unwrap_or_default();
            format!("- {} ({}){tail}", b.name(), b.id())
        })
        .collect();
    Ok(text(rows.join("\n")))
}

fn call(last: &Last, name: &str, a: &Value) -> Result<Value, String> {
    let said = |r: Value| text(r["text"].as_str().unwrap_or(""));
    match name {
        "browsers" => browsers(a),
        "tabs" => {
            let r = into(last, a, "tabs", json!({}))?;
            let mark = |t: &Value, k: &str, s: &'static str| if flag(&t[k]) { s } else { "" };
            let rows: Vec<String> = r
                .as_array()
                .into_iter()
                .flatten()
                .map(|t| format!("- {}{}{}{}: {} | {}", t["id"], mark(t, "mine", " (yours)"), mark(t, "popup", " (popup)"), mark(t, "front", " (the person's current tab)"), t["title"].as_str().unwrap_or(""), t["url"].as_str().unwrap_or("")))
                .collect();
            Ok(text(rows.join("\n")))
        }
        "open" => Ok(said(into(last, a, "open", json!({ "url": a["url"], "show": a["show"] }))?)),
        "read" => Ok(said(into(last, a, "read", json!({ "find": a["find"], "text": a["text"], "max": a["max"] }))?)),
        "act" => {
            let mut steps = a["actions"].as_array().filter(|s| !s.is_empty()).cloned().ok_or("Give actions: a list of steps.")?;
            for s in steps.iter_mut() {
                if s.get("upload").is_some() {
                    s["files"] = files(&s["files"])?;
                }
            }
            Ok(said(into(last, a, "act", json!({ "actions": steps, "trusted": a["trusted"] }))?))
        }
        "upload" => {
            let step = json!({ "upload": a.get("to").filter(|t| !t.is_null()).cloned().unwrap_or(json!("")), "files": files(&a["files"])? });
            Ok(said(into(last, a, "act", json!({ "actions": [step] }))?))
        }
        "screenshot" => {
            let r = into(last, a, "shot", json!({}))?;
            Ok(json!({ "content": [{ "type": "image", "data": r["data"], "mimeType": "image/jpeg" }, { "type": "text", "text": format!("Tab {}.", r["tab"]) }] }))
        }
        "eval" => Ok(said(into(last, a, "eval", json!({ "js": a["js"] }))?)),
        "close" => Ok(said(into(last, a, "close", json!({}))?)),
        _ => Err(format!("Unknown tool {name}")),
    }
}

fn handle(last: &Last, m: Value) -> Option<Value> {
    let id = m.get("id")?.clone();
    let p = &m["params"];
    let result = match m["method"].as_str().unwrap_or("") {
        "initialize" => json!({
            "protocolVersion": p["protocolVersion"].as_str().unwrap_or("2025-06-18"),
            "capabilities": { "tools": {} },
            "serverInfo": { "name": "efferent", "version": env!("CARGO_PKG_VERSION") },
            "instructions": INSTRUCTIONS,
        }),
        "ping" => json!({}),
        "tools/list" => json!({ "tools": serde_json::from_str::<Value>(TOOLS).unwrap() }),
        "tools/call" => match call(last, p["name"].as_str().unwrap_or(""), &p.get("arguments").cloned().unwrap_or(json!({}))) {
            Ok(r) => r,
            Err(e) => {
                let mut r = text(e);
                r["isError"] = json!(true);
                r
            }
        },
        other => return Some(json!({ "jsonrpc": "2.0", "id": id, "error": { "code": -32601, "message": format!("Unknown method {other}") } })),
    };
    Some(json!({ "jsonrpc": "2.0", "id": id, "result": result }))
}

fn main() {
    if std::env::args().nth(1).as_deref() == Some("extension") {
        let home = std::env::var("USERPROFILE").or_else(|_| std::env::var("HOME")).unwrap_or_else(|_| ".".into());
        let to = Path::new(&home).join(".efferent").join("extension");
        std::fs::create_dir_all(&to).expect("create the extension folder");
        for (name, bytes) in EXTENSION {
            std::fs::write(to.join(name), bytes).expect("write the extension");
        }
        println!("The extension is in {}\nIn your browser open chrome://extensions, turn on Developer mode, click Load unpacked and pick that folder.", to.display());
        return;
    }
    if bridge::listen().is_none() {
        eprintln!("efferent: every port from 47800 to 47807 is taken, so no browser can connect.");
    }
    let out = Arc::new(Mutex::new(std::io::stdout()));
    let last: Last = Default::default();
    for line in std::io::stdin().lock().lines().map_while(Result::ok) {
        if line.trim().is_empty() {
            continue;
        }
        let (out, last) = (out.clone(), last.clone());
        std::thread::spawn(move || {
            let reply = match serde_json::from_str::<Value>(&line) {
                Ok(m) => handle(&last, m),
                Err(_) => Some(json!({ "jsonrpc": "2.0", "id": null, "error": { "code": -32700, "message": "Parse error" } })),
            };
            if let Some(r) = reply {
                let mut o = out.lock().unwrap();
                let _ = writeln!(o, "{r}");
                let _ = o.flush();
            }
        });
    }
}
