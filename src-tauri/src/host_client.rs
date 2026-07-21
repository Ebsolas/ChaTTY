//! Client for chatty-host (runs inside the Tauri UI process).

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::{self, Receiver, Sender};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

#[cfg(unix)]
use std::os::unix::net::UnixStream;

use serde_json::{json, Value};
use tauri::{AppHandle, Emitter};

use crate::host_protocol::{
    self, ActivitySnapshot, CreateParams, Event, Request, Response, SessionSummary,
};
use crate::host_server;
use crate::session::{PaneActivity, SessionActivityEvent, SessionExitEvent, SessionOutputEvent};

/// Which engine the UI process should use for PTYs.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SessionEngine {
    /// Durable host process (cross-platform design; Unix socket today).
    Host,
    /// Legacy in-process tmux/plain PTY (Linux-oriented).
    Legacy,
}

pub fn session_engine() -> SessionEngine {
    match std::env::var("CHATTY_SESSION_ENGINE")
        .unwrap_or_default()
        .to_ascii_lowercase()
        .as_str()
    {
        "host" | "daemon" | "chatty-host" => SessionEngine::Host,
        "tmux" | "legacy" | "plain" => SessionEngine::Legacy,
        "" => {
            #[cfg(unix)]
            {
                SessionEngine::Host
            }
            #[cfg(not(unix))]
            {
                SessionEngine::Legacy
            }
        }
        _ => SessionEngine::Host,
    }
}

struct Shared {
    writer: Mutex<UnixStream>,
    next_id: AtomicU64,
    /// Pending RPC waiters keyed by request id.
    waiters: Mutex<HashMap<u64, Sender<Response>>>,
    pump_started: AtomicBool,
}

pub struct HostClient {
    shared: Arc<Shared>,
}

impl HostClient {
    pub fn connect_existing() -> Result<Self, String> {
        #[cfg(unix)]
        {
            let sock = host_protocol::socket_path();
            let stream = UnixStream::connect(&sock)
                .map_err(|e| format!("connect {}: {e}", sock.display()))?;
            let reader_stream = stream
                .try_clone()
                .map_err(|e| format!("clone stream: {e}"))?;
            let shared = Arc::new(Shared {
                writer: Mutex::new(stream),
                next_id: AtomicU64::new(1),
                waiters: Mutex::new(HashMap::new()),
                pump_started: AtomicBool::new(false),
            });
            // Always run demux reader so RPC + events share one connection safely.
            start_demux(Arc::clone(&shared), reader_stream, None);
            shared.pump_started.store(true, Ordering::SeqCst);
            Ok(Self { shared })
        }
        #[cfg(not(unix))]
        {
            Err("host client requires Unix in this build".into())
        }
    }

    pub fn ensure_connected(host_bin: &Path) -> Result<Self, String> {
        host_server::ensure_host_process(host_bin)?;
        Self::connect_existing()
    }

    /// Attach Tauri event emission to the demux (call once after connect).
    pub fn set_app_emitter(&self, app: AppHandle) {
        // Restart is not needed — we pass app via a side channel.
        // For v1: store app in a static/once once demux already running is awkward.
        // Instead, demux was started without app; use a global for events.
        let mut slot = APP_EMIT.lock().unwrap_or_else(|e| e.into_inner());
        *slot = Some(app);
    }

    fn rpc(&self, method: &str, params: Value) -> Result<Value, String> {
        let id = self.shared.next_id.fetch_add(1, Ordering::SeqCst);
        let (tx, rx): (Sender<Response>, Receiver<Response>) = mpsc::channel();
        {
            let mut w = self
                .shared
                .waiters
                .lock()
                .map_err(|e| e.to_string())?;
            w.insert(id, tx);
        }
        let req = Request {
            id,
            method: method.into(),
            params,
        };
        let line = serde_json::to_string(&req).map_err(|e| e.to_string())?;
        {
            let mut w = self.shared.writer.lock().map_err(|e| e.to_string())?;
            writeln!(w, "{line}").map_err(|e| format!("write rpc: {e}"))?;
            w.flush().map_err(|e| format!("flush rpc: {e}"))?;
        }

        let resp = rx
            .recv_timeout(Duration::from_secs(30))
            .map_err(|_| "host rpc timeout".to_string())?;
        if resp.ok {
            Ok(resp.result.unwrap_or(Value::Null))
        } else {
            Err(resp.error.unwrap_or_else(|| "host error".into()))
        }
    }

    pub fn ping(&mut self) -> Result<Value, String> {
        self.rpc("ping", json!({}))
    }

    pub fn create(
        &self,
        session_id: &str,
        shell: &str,
        cwd: &str,
        cols: u16,
        rows: u16,
    ) -> Result<SessionSummary, String> {
        let v = self.rpc(
            "session.create",
            serde_json::to_value(CreateParams {
                session_id: session_id.into(),
                shell: shell.into(),
                cwd: cwd.into(),
                cols: Some(cols),
                rows: Some(rows),
            })
            .unwrap_or(json!({})),
        )?;
        serde_json::from_value(v).map_err(|e| e.to_string())
    }

    pub fn list(&self) -> Result<Vec<SessionSummary>, String> {
        let v = self.rpc("session.list", json!({}))?;
        serde_json::from_value(v).map_err(|e| e.to_string())
    }

    pub fn attach(&self, session_id: &str) -> Result<String, String> {
        let v = self.rpc("session.attach", json!({ "sessionId": session_id }))?;
        Ok(v
            .get("replay")
            .and_then(|x| x.as_str())
            .unwrap_or("")
            .to_string())
    }

    pub fn write_bytes(&self, session_id: &str, bytes: &[u8]) -> Result<(), String> {
        let data = String::from_utf8_lossy(bytes);
        self.rpc(
            "session.write",
            json!({ "sessionId": session_id, "data": data }),
        )
        .map(|_| ())
    }

    pub fn resize(&self, session_id: &str, cols: u16, rows: u16) -> Result<(), String> {
        self.rpc(
            "session.resize",
            json!({ "sessionId": session_id, "cols": cols, "rows": rows }),
        )
        .map(|_| ())
    }

    pub fn destroy(&self, session_id: &str) -> Result<(), String> {
        self.rpc("session.destroy", json!({ "sessionId": session_id }))
            .map(|_| ())
    }
}

static APP_EMIT: Mutex<Option<AppHandle>> = Mutex::new(None);

#[cfg(unix)]
fn start_demux(shared: Arc<Shared>, stream: UnixStream, _app: Option<AppHandle>) {
    thread::Builder::new()
        .name("host-demux".into())
        .spawn(move || {
            let mut reader = BufReader::new(stream);
            loop {
                let mut buf = String::new();
                match reader.read_line(&mut buf) {
                    Ok(0) => break,
                    Ok(_) => {}
                    Err(_) => break,
                }
                let trimmed = buf.trim();
                if trimmed.is_empty() {
                    continue;
                }
                if let Ok(resp) = serde_json::from_str::<Response>(trimmed) {
                    if let Ok(mut waiters) = shared.waiters.lock() {
                        if let Some(tx) = waiters.remove(&resp.id) {
                            let _ = tx.send(resp);
                        }
                    }
                    continue;
                }
                if let Ok(ev) = serde_json::from_str::<Event>(trimmed) {
                    if let Ok(slot) = APP_EMIT.lock() {
                        if let Some(app) = slot.as_ref() {
                            dispatch_host_event(app, &ev);
                        }
                    }
                }
            }
        })
        .ok();
}

fn dispatch_host_event(app: &AppHandle, ev: &Event) {
    match ev.event.as_str() {
        "session.output" => {
            if let Ok(p) = serde_json::from_value::<SessionOutputEvent>(ev.params.clone()) {
                let _ = app.emit("session-output", p);
            }
        }
        "session.activity" => {
            if let Ok(snap) = serde_json::from_value::<ActivitySnapshot>(ev.params.clone()) {
                let activity = match snap.activity {
                    host_protocol::ActivityKind::Idle => PaneActivity::Idle,
                    host_protocol::ActivityKind::Busy => PaneActivity::Busy,
                    host_protocol::ActivityKind::Tui => PaneActivity::Tui,
                };
                let _ = app.emit(
                    "session-activity",
                    SessionActivityEvent {
                        session_id: snap.session_id,
                        activity,
                        command: snap.command,
                        cwd: snap.cwd,
                    },
                );
            }
        }
        "session.exit" => {
            let sid = ev
                .params
                .get("sessionId")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            if !sid.is_empty() {
                let _ = app.emit(
                    "session-exit",
                    SessionExitEvent {
                        session_id: sid,
                        code: None,
                    },
                );
            }
        }
        _ => {}
    }
}

/// Resolve path to chatty-host binary (dev, AppImage/sidecar, installed).
///
/// Search order:
/// 1. `CHATTY_HOST_BIN` override
/// 2. Same directory as the Chatty UI executable (Tauri `externalBin` / AppImage)
/// 3. Common resource layouts next to the exe
/// 4. Bare `chatty-host` on `PATH`
pub fn resolve_host_binary() -> PathBuf {
    if let Ok(p) = std::env::var("CHATTY_HOST_BIN") {
        let pb = PathBuf::from(p);
        if pb.is_file() {
            return pb;
        }
    }

    #[cfg(windows)]
    const HOST_NAME: &str = "chatty-host.exe";
    #[cfg(not(windows))]
    const HOST_NAME: &str = "chatty-host";

    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            // AppImage / externalBin: sidecar sits next to the main binary.
            let next_to_exe = dir.join(HOST_NAME);
            if next_to_exe.is_file() {
                return next_to_exe;
            }
            // Some layouts keep helpers one level up or under bin/.
            for rel in ["bin", ".", ".."] {
                let cand = dir.join(rel).join(HOST_NAME);
                if cand.is_file() {
                    return cand;
                }
            }
            // AppImage mount: .../usr/bin/chatty → sibling chatty-host
            // Also try unsuffixed path when current_exe is a symlink/wrapper.
            if let Ok(canon) = exe.canonicalize() {
                if let Some(cdir) = canon.parent() {
                    let cand = cdir.join(HOST_NAME);
                    if cand.is_file() {
                        return cand;
                    }
                }
            }
        }
    }

    PathBuf::from(HOST_NAME)
}
