use serde_json::{json, Value};
use std::collections::HashMap;
use std::net::{TcpListener, TcpStream};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{channel, Sender};
use std::sync::{Arc, Mutex, OnceLock};
use std::thread;
use std::time::{Duration, Instant};
use tungstenite::handshake::server::{ErrorResponse, Request, Response};
use tungstenite::{Message, WebSocket};

const FIRST_PORT: u16 = 47800;
const DEFAULT_ID: &str = "djkbgokjopagggpagplncnbanmpanhlh";

type Reply = Result<Value, String>;

pub struct Browser {
    who: Mutex<(String, String)>,
    at: Instant,
    ws: Mutex<WebSocket<TcpStream>>,
    pending: Mutex<HashMap<String, Sender<Reply>>>,
}

impl Browser {
    pub fn id(&self) -> String { self.who.lock().unwrap().0.clone() }
    pub fn name(&self) -> String { self.who.lock().unwrap().1.clone() }
}

fn browsers() -> &'static Mutex<Vec<Arc<Browser>>> {
    static B: OnceLock<Mutex<Vec<Arc<Browser>>>> = OnceLock::new();
    B.get_or_init(Default::default)
}

pub fn listen() -> Option<u16> {
    for port in FIRST_PORT..FIRST_PORT + 8 {
        if let Ok(l) = TcpListener::bind(("127.0.0.1", port)) {
            thread::spawn(move || {
                for s in l.incoming().flatten() {
                    thread::spawn(move || serve(s));
                }
            });
            return Some(port);
        }
    }
    None
}

fn serve(stream: TcpStream) {
    let ext = std::env::var("EFFERENT_EXTENSION_ID").unwrap_or_else(|_| DEFAULT_ID.into());
    let origin = format!("chrome-extension://{ext}");
    let _ = stream.set_nodelay(true);
    let check = |req: &Request, res: Response| -> Result<Response, ErrorResponse> {
        let h = |k: &str| req.headers().get(k).and_then(|v| v.to_str().ok()).unwrap_or("");
        let host = h("host").rsplit_once(':').map_or(h("host"), |(a, _)| a);
        if h("origin") == origin && (host == "127.0.0.1" || host == "localhost") {
            return Ok(res);
        }
        let mut no = ErrorResponse::new(Some("efferent: only its extension may connect".into()));
        *no.status_mut() = tungstenite::http::StatusCode::FORBIDDEN;
        Err(no)
    };
    let Ok(ws) = tungstenite::accept_hdr(stream, check) else { return };
    let _ = ws.get_ref().set_read_timeout(Some(Duration::from_millis(5)));
    let b = Arc::new(Browser { who: Mutex::new((String::new(), String::new())), at: Instant::now(), ws: Mutex::new(ws), pending: Default::default() });
    loop {
        let msg = b.ws.lock().unwrap().read();
        match msg {
            Ok(Message::Text(t)) => {
                let Ok(m) = serde_json::from_str::<Value>(&t) else { continue };
                if let Some(h) = m.get("hello") {
                    let s = |k: &str| h[k].as_str().unwrap_or("").to_string();
                    *b.who.lock().unwrap() = (s("id"), s("name"));
                    let mut all = browsers().lock().unwrap();
                    if !all.iter().any(|x| Arc::ptr_eq(x, &b)) { all.push(b.clone()) }
                    continue;
                }
                let Some(id) = m["id"].as_str() else { continue };
                if let Some(tx) = b.pending.lock().unwrap().remove(id) {
                    let _ = tx.send(match m.get("error") { Some(e) => Err(e.as_str().unwrap_or("error").into()), None => Ok(m["result"].clone()) });
                }
            }
            Ok(_) => {}
            Err(tungstenite::Error::Io(e)) if matches!(e.kind(), std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut) => {
                thread::sleep(Duration::from_millis(2));
            }
            Err(_) => break,
        }
    }
    browsers().lock().unwrap().retain(|x| !Arc::ptr_eq(x, &b));
    for (_, tx) in b.pending.lock().unwrap().drain() {
        let _ = tx.send(Err(format!("{} disconnected.", b.name())));
    }
}

pub fn connected() -> Vec<Arc<Browser>> {
    let mut all = browsers().lock().unwrap().clone();
    all.sort_by_key(|b| b.at);
    all
}

pub fn pick(name: Option<&str>) -> Result<Arc<Browser>, String> {
    for _ in 0..80 {
        if !browsers().lock().unwrap().is_empty() { break }
        thread::sleep(Duration::from_millis(100));
    }
    let all = connected();
    if all.is_empty() {
        return Err("No browser is connected. Open a Chromium browser with the efferent extension installed (chrome://extensions, Developer mode, Load unpacked, the extension folder) and make sure it is switched on in its toolbar button.".into());
    }
    let env = std::env::var("EFFERENT_BROWSER").ok();
    let Some(want) = name.map(String::from).or(env) else { return Ok(all[0].clone()) };
    let low = want.to_lowercase();
    all.iter().find(|b| b.id() == want || b.name().to_lowercase() == low)
        .or_else(|| all.iter().find(|b| b.name().to_lowercase().contains(&low)))
        .cloned()
        .ok_or_else(|| format!("No connected browser is named \"{want}\". Connected: {}.", all.iter().map(|b| b.name()).collect::<Vec<_>>().join(", ")))
}

pub fn request(b: &Browser, method: &str, params: Value, secs: u64) -> Reply {
    static SEQ: AtomicU64 = AtomicU64::new(0);
    let id = SEQ.fetch_add(1, Ordering::Relaxed).to_string();
    let (tx, rx) = channel();
    b.pending.lock().unwrap().insert(id.clone(), tx);
    let body = json!({ "id": id, "method": method, "params": params }).to_string();
    if b.ws.lock().unwrap().send(Message::text(body)).is_err() {
        b.pending.lock().unwrap().remove(&id);
        return Err(format!("{} disconnected.", b.name()));
    }
    rx.recv_timeout(Duration::from_secs(secs)).unwrap_or_else(|_| {
        b.pending.lock().unwrap().remove(&id);
        Err(format!("{} took longer than {secs} s.", b.name()))
    })
}
