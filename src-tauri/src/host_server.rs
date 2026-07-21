//! Durable session host: owns PTYs, outlives the UI, answers activity queries.
//!
//! This replaces tmux for the features Chatty actually needs (see plan).

use std::collections::{HashMap, VecDeque};
use std::io::{BufRead, BufReader, Read, Write};
use std::net::Shutdown;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

#[cfg(unix)]
use std::os::fd::RawFd;
#[cfg(unix)]
use std::os::unix::net::{UnixListener, UnixStream};

/// Batch PTY output briefly, then always idle-drain so short commands (whoami)
/// are not stuck until the next 4KB of output or process exit.
const EMIT_COALESCE: Duration = Duration::from_millis(32);
const EMIT_HIGH_WATER: usize = 4096;

use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize};
use serde_json::json;

use crate::host_protocol::{
    self, ActivityKind, ActivitySnapshot, CreateParams, Event, Request, ResizeParams, Response,
    SessionIdParams, SessionSummary, WriteParams, PROTOCOL_VERSION, RING_MAX,
};

type ClientId = u64;
type OutputTx = std::sync::mpsc::Sender<ClientMsg>;

enum ClientMsg {
    Line(String),
}

struct Ring {
    buf: VecDeque<u8>,
    max: usize,
}

impl Ring {
    fn new(max: usize) -> Self {
        Self {
            buf: VecDeque::with_capacity(max.min(64 * 1024)),
            max,
        }
    }

    fn push_str(&mut self, s: &str) {
        for b in s.as_bytes() {
            if self.buf.len() >= self.max {
                self.buf.pop_front();
            }
            self.buf.push_back(*b);
        }
    }

    fn snapshot(&self) -> String {
        String::from_utf8_lossy(&self.buf.iter().copied().collect::<Vec<_>>()).into_owned()
    }
}

struct HostSession {
    session_id: String,
    shell: String,
    cwd: PathBuf,
    pid: u32,
    alive: Arc<AtomicBool>,
    writer: Arc<Mutex<Box<dyn Write + Send>>>,
    master: Arc<Mutex<Box<dyn MasterPty + Send>>>,
    ring: Arc<Mutex<Ring>>,
    /// Fan-out of output lines (already JSON event strings) to attached UI clients.
    attachers: Arc<Mutex<HashMap<ClientId, OutputTx>>>,
    last_activity: Mutex<Option<ActivitySnapshot>>,
    _child_killer: Mutex<Box<dyn portable_pty::ChildKiller + Send + Sync>>,
}

struct HostState {
    sessions: HashMap<String, Arc<HostSession>>,
    next_client: AtomicU32,
}

impl HostState {
    fn new() -> Self {
        Self {
            sessions: HashMap::new(),
            next_client: AtomicU32::new(1),
        }
    }
}

pub fn run_server() -> Result<(), String> {
    let dir = host_protocol::runtime_dir();
    std::fs::create_dir_all(&dir).map_err(|e| format!("runtime dir: {e}"))?;

    let sock = host_protocol::socket_path();
    let pid_file = host_protocol::pid_path();

    // Stale socket from a dead host.
    if sock.exists() {
        let _ = std::fs::remove_file(&sock);
    }

    #[cfg(unix)]
    {
        let listener = UnixListener::bind(&sock).map_err(|e| format!("bind socket: {e}"))?;
        // Restrict to user.
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::set_permissions(&sock, std::fs::Permissions::from_mode(0o600));
        }

        std::fs::write(&pid_file, format!("{}\n", std::process::id()))
            .map_err(|e| format!("pid file: {e}"))?;

        eprintln!(
            "chatty-host v{PROTOCOL_VERSION} listening on {} (pid {})",
            sock.display(),
            std::process::id()
        );

        let state = Arc::new(Mutex::new(HostState::new()));
        // Global activity poller.
        {
            let st = Arc::clone(&state);
            thread::Builder::new()
                .name("host-activity".into())
                .spawn(move || activity_loop(st))
                .ok();
        }

        for stream in listener.incoming() {
            match stream {
                Ok(stream) => {
                    let st = Arc::clone(&state);
                    thread::Builder::new()
                        .name("host-client".into())
                        .spawn(move || {
                            if let Err(e) = handle_client(st, stream) {
                                eprintln!("chatty-host client error: {e}");
                            }
                        })
                        .ok();
                }
                Err(e) => eprintln!("chatty-host accept: {e}"),
            }
        }
        Ok(())
    }

    #[cfg(not(unix))]
    {
        Err("chatty-host IPC is Unix-only in this build; Windows named pipes come next".into())
    }
}

fn activity_loop(state: Arc<Mutex<HostState>>) {
    loop {
        thread::sleep(Duration::from_millis(400));
        let sessions: Vec<Arc<HostSession>> = {
            let Ok(guard) = state.lock() else {
                continue;
            };
            guard.sessions.values().cloned().collect()
        };
        for sess in sessions {
            if !sess.alive.load(Ordering::SeqCst) {
                continue;
            }
            let snap = inspect_activity(&sess);
            let mut last = sess.last_activity.lock().unwrap_or_else(|e| e.into_inner());
            let changed = last.as_ref().map(|l| {
                l.activity != snap.activity
                    || l.command != snap.command
                    || l.cwd != snap.cwd
            }).unwrap_or(true);
            if !changed {
                continue;
            }
            *last = Some(snap.clone());
            drop(last);
            let line = serde_json::to_string(&Event {
                event: "session.activity".into(),
                params: serde_json::to_value(&snap).unwrap_or(json!({})),
            })
            .unwrap_or_default();
            fanout(&sess, &line);
        }
    }
}

fn fanout(sess: &HostSession, line: &str) {
    let mut dead = Vec::new();
    if let Ok(mut map) = sess.attachers.lock() {
        for (cid, tx) in map.iter() {
            if tx.send(ClientMsg::Line(line.to_string())).is_err() {
                dead.push(*cid);
            }
        }
        for cid in dead {
            map.remove(&cid);
        }
    }
}

fn inspect_activity(sess: &HostSession) -> ActivitySnapshot {
    let cwd = read_cwd(sess.pid).unwrap_or_else(|| sess.cwd.display().to_string());
    let (command, activity) = foreground_command(sess.pid, &sess.shell);
    ActivitySnapshot {
        session_id: sess.session_id.clone(),
        activity,
        command,
        cwd,
    }
}

fn foreground_command(root_pid: u32, shell_path: &str) -> (String, ActivityKind) {
    #[cfg(target_os = "linux")]
    {
        return foreground_linux(root_pid, shell_path);
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = root_pid;
        let base = std::path::Path::new(shell_path)
            .file_name()
            .and_then(|s| s.to_str())
            .unwrap_or("shell")
            .to_ascii_lowercase();
        (base, ActivityKind::Idle)
    }
}

#[cfg(target_os = "linux")]
fn foreground_linux(root_pid: u32, shell_path: &str) -> (String, ActivityKind) {
    use std::collections::{HashSet, VecDeque};

    let shell_base = std::path::Path::new(shell_path)
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();

    let shells: HashSet<&str> = [
        "zsh", "bash", "fish", "sh", "dash", "ksh", "csh", "tcsh", "nu", "pwsh", "powershell",
        "tmux",
    ]
    .into_iter()
    .collect();

    let is_shell = |name: &str| {
        let n = name.to_ascii_lowercase();
        shells.contains(n.as_str())
            || (!shell_base.is_empty() && (n == shell_base || n.ends_with(&format!("/{shell_base}"))))
    };

    // If root is a shell, trust that for idle unless a non-shell child exists.
    let root_comm = read_comm(root_pid).unwrap_or_default().to_ascii_lowercase();
    if is_shell(&root_comm) {
        // Prefer first non-shell descendant (foreground-ish).
        let mut q = VecDeque::from([root_pid as i32]);
        let mut seen = HashSet::new();
        while let Some(pid) = q.pop_front() {
            if !seen.insert(pid) {
                continue;
            }
            if pid as u32 != root_pid {
                let comm = read_comm(pid as u32).unwrap_or_default();
                let comm_l = comm.to_ascii_lowercase();
                if !comm_l.is_empty() && !is_shell(&comm_l) {
                    let name = resolve_display_name(pid as u32, &comm_l);
                    return (name.clone(), classify(&name));
                }
            }
            for c in proc_children(pid) {
                q.push_back(c);
            }
        }
        return (root_comm, ActivityKind::Idle);
    }

    let name = resolve_display_name(root_pid, &root_comm);
    (name.clone(), classify(&name))
}

#[cfg(target_os = "linux")]
fn resolve_display_name(pid: u32, comm_l: &str) -> String {
    const INTERPRETERS: &[&str] = &[
        "python", "python2", "python3", "node", "nodejs", "perl", "ruby", "lua", "php",
    ];
    if INTERPRETERS
        .iter()
        .any(|i| comm_l == *i || comm_l.starts_with(&format!("{i}.")))
    {
        if let Some(cmd) = read_cmdline(pid) {
            for tok in cmd.split_whitespace() {
                if tok.starts_with('-') {
                    continue;
                }
                let base = tok.rsplit('/').next().unwrap_or(tok).to_ascii_lowercase();
                if base.is_empty()
                    || INTERPRETERS
                        .iter()
                        .any(|i| base == *i || base.starts_with(&format!("{i}.")))
                {
                    continue;
                }
                return base;
            }
        }
    }
    comm_l.to_string()
}

fn classify(name: &str) -> ActivityKind {
    let base = name.rsplit('/').next().unwrap_or(name).to_ascii_lowercase();
    const TUIS: &[&str] = &[
        "vim", "nvim", "vi", "view", "vimdiff", "nvimdiff", "emacs", "nano", "micro", "helix",
        "kak", "htop", "btop", "top", "iotop", "nvitop", "less", "more", "most", "ranger", "lf",
        "nnn", "vifm", "mc", "lazygit", "tig", "gitui", "fzf", "fzy", "watch", "man", "info",
    ];
    if TUIS.iter().any(|t| base == *t) {
        ActivityKind::Tui
    } else {
        ActivityKind::Busy
    }
}

#[cfg(target_os = "linux")]
fn read_comm(pid: u32) -> Option<String> {
    let s = std::fs::read_to_string(format!("/proc/{pid}/comm")).ok()?;
    Some(s.trim().to_string())
}

#[cfg(target_os = "linux")]
fn read_cmdline(pid: u32) -> Option<String> {
    let raw = std::fs::read(format!("/proc/{pid}/cmdline")).ok()?;
    if raw.is_empty() {
        return None;
    }
    let parts: Vec<&str> = raw
        .split(|b| *b == 0)
        .filter(|p| !p.is_empty())
        .filter_map(|p| std::str::from_utf8(p).ok())
        .collect();
    if parts.is_empty() {
        None
    } else {
        Some(parts.join(" "))
    }
}

#[cfg(target_os = "linux")]
fn read_cwd(pid: u32) -> Option<String> {
    std::fs::read_link(format!("/proc/{pid}/cwd"))
        .ok()
        .map(|p| p.display().to_string())
}

#[cfg(not(target_os = "linux"))]
fn read_cwd(_pid: u32) -> Option<String> {
    None
}

#[cfg(target_os = "linux")]
fn proc_children(pid: i32) -> Vec<i32> {
    let mut kids = Vec::new();
    let task_dir = format!("/proc/{pid}/task");
    let Ok(entries) = std::fs::read_dir(task_dir) else {
        return kids;
    };
    for ent in entries.flatten() {
        let path = ent.path().join("children");
        if let Ok(text) = std::fs::read_to_string(path) {
            for tok in text.split_whitespace() {
                if let Ok(c) = tok.parse::<i32>() {
                    kids.push(c);
                }
            }
        }
    }
    kids.sort_unstable();
    kids.dedup();
    kids
}

#[cfg(unix)]
fn handle_client(state: Arc<Mutex<HostState>>, stream: UnixStream) -> Result<(), String> {
    let reader_stream = stream
        .try_clone()
        .map_err(|e| format!("clone stream: {e}"))?;
    let writer = stream
        .try_clone()
        .map_err(|e| format!("clone stream writer: {e}"))?;
    let writer = Arc::new(Mutex::new(writer));

    let client_id = {
        let st = state.lock().map_err(|e| e.to_string())?;
        st.next_client.fetch_add(1, Ordering::SeqCst) as ClientId
    };

    // Outbound event pump for this client.
    let (tx, rx) = std::sync::mpsc::channel::<ClientMsg>();
    {
        let w = Arc::clone(&writer);
        thread::Builder::new()
            .name(format!("host-out-{client_id}"))
            .spawn(move || {
                while let Ok(msg) = rx.recv() {
                    match msg {
                        ClientMsg::Line(line) => {
                            let mut guard = match w.lock() {
                                Ok(g) => g,
                                Err(_) => break,
                            };
                            if writeln!(guard, "{line}").is_err() {
                                break;
                            }
                            let _ = guard.flush();
                        }
                    }
                }
            })
            .ok();
    }

    let mut reader = BufReader::new(reader_stream);
    let mut line = String::new();
    // Track sessions this client attached to for cleanup.
    let mut attached: Vec<String> = Vec::new();

    loop {
        line.clear();
        let n = reader
            .read_line(&mut line)
            .map_err(|e| format!("read: {e}"))?;
        if n == 0 {
            break;
        }
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let req: Request = match serde_json::from_str(trimmed) {
            Ok(r) => r,
            Err(e) => {
                let resp = Response {
                    id: 0,
                    ok: false,
                    result: None,
                    error: Some(format!("bad request: {e}")),
                };
                write_response(&writer, &resp)?;
                continue;
            }
        };

        let resp = dispatch(
            &state,
            client_id,
            &tx,
            &mut attached,
            &req,
        );
        write_response(&writer, &resp)?;
    }

    // Detach on disconnect.
    for sid in attached {
        detach_client(&state, &sid, client_id);
    }
    let _ = stream.shutdown(Shutdown::Both);
    Ok(())
}

fn write_response(writer: &Arc<Mutex<impl Write>>, resp: &Response) -> Result<(), String> {
    let line = serde_json::to_string(resp).map_err(|e| e.to_string())?;
    let mut w = writer.lock().map_err(|e| e.to_string())?;
    writeln!(w, "{line}").map_err(|e| e.to_string())?;
    w.flush().map_err(|e| e.to_string())
}

fn dispatch(
    state: &Arc<Mutex<HostState>>,
    client_id: ClientId,
    tx: &OutputTx,
    attached: &mut Vec<String>,
    req: &Request,
) -> Response {
    let respond_ok = |id, result| Response {
        id,
        ok: true,
        result: Some(result),
        error: None,
    };
    let respond_err = |id, error: String| Response {
        id,
        ok: false,
        result: None,
        error: Some(error),
    };

    match req.method.as_str() {
        "ping" => respond_ok(
            req.id,
            json!({ "version": PROTOCOL_VERSION, "pid": std::process::id() }),
        ),
        "session.create" => match serde_json::from_value::<CreateParams>(req.params.clone()) {
            Ok(p) => match create_session(state, p) {
                Ok(summary) => respond_ok(req.id, serde_json::to_value(summary).unwrap_or(json!({}))),
                Err(e) => respond_err(req.id, e),
            },
            Err(e) => respond_err(req.id, e.to_string()),
        },
        "session.list" => {
            let Ok(guard) = state.lock() else {
                return respond_err(req.id, "lock poisoned".into());
            };
            let list: Vec<SessionSummary> = guard
                .sessions
                .values()
                .map(|s| SessionSummary {
                    session_id: s.session_id.clone(),
                    shell: s.shell.clone(),
                    cwd: s.cwd.display().to_string(),
                    pid: s.pid,
                    alive: s.alive.load(Ordering::SeqCst),
                })
                .collect();
            respond_ok(req.id, json!(list))
        }
        "session.attach" => match serde_json::from_value::<SessionIdParams>(req.params.clone()) {
            Ok(p) => match attach_session(state, &p.session_id, client_id, tx.clone()) {
                Ok(replay) => {
                    if !attached.contains(&p.session_id) {
                        attached.push(p.session_id.clone());
                    }
                    respond_ok(req.id, json!({ "replay": replay }))
                }
                Err(e) => respond_err(req.id, e),
            },
            Err(e) => respond_err(req.id, e.to_string()),
        },
        "session.detach" => match serde_json::from_value::<SessionIdParams>(req.params.clone()) {
            Ok(p) => {
                detach_client(state, &p.session_id, client_id);
                attached.retain(|s| s != &p.session_id);
                respond_ok(req.id, json!({}))
            }
            Err(e) => respond_err(req.id, e.to_string()),
        },
        "session.write" => match serde_json::from_value::<WriteParams>(req.params.clone()) {
            Ok(p) => match write_session(state, &p.session_id, p.data.as_bytes()) {
                Ok(()) => respond_ok(req.id, json!({})),
                Err(e) => respond_err(req.id, e),
            },
            Err(e) => respond_err(req.id, e.to_string()),
        },
        "session.resize" => match serde_json::from_value::<ResizeParams>(req.params.clone()) {
            Ok(p) => match resize_session(state, &p.session_id, p.cols, p.rows) {
                Ok(()) => respond_ok(req.id, json!({})),
                Err(e) => respond_err(req.id, e),
            },
            Err(e) => respond_err(req.id, e.to_string()),
        },
        "session.destroy" => match serde_json::from_value::<SessionIdParams>(req.params.clone()) {
            Ok(p) => match destroy_session(state, &p.session_id) {
                Ok(()) => {
                    attached.retain(|s| s != &p.session_id);
                    respond_ok(req.id, json!({}))
                }
                Err(e) => respond_err(req.id, e),
            },
            Err(e) => respond_err(req.id, e.to_string()),
        },
        other => respond_err(req.id, format!("unknown method: {other}")),
    }
}

/// Coalesce PTY reads, but **always drain on idle** so short command output
/// is not stuck until the next keypress / 4KB burst / process exit.
#[cfg(unix)]
fn host_pty_read_loop(
    reader: &mut Box<dyn Read + Send>,
    fd: RawFd,
    alive: &AtomicBool,
    ring: &Mutex<Ring>,
    attachers: &Mutex<HashMap<ClientId, OutputTx>>,
    session_id: &str,
) {
    let mut buf = [0u8; 8192];
    let mut pending = String::new();
    let mut last_data = Instant::now();

    let flush = |pending: &mut String| {
        if pending.is_empty() {
            return;
        }
        let chunk = std::mem::take(pending);
        if let Ok(mut r) = ring.lock() {
            r.push_str(&chunk);
        }
        let ev = Event {
            event: "session.output".into(),
            params: json!({ "sessionId": session_id, "chunk": chunk }),
        };
        if let Ok(line) = serde_json::to_string(&ev) {
            if let Ok(mut map) = attachers.lock() {
                let mut dead = Vec::new();
                for (cid, tx) in map.iter() {
                    if tx.send(ClientMsg::Line(line.clone())).is_err() {
                        dead.push(*cid);
                    }
                }
                for cid in dead {
                    map.remove(&cid);
                }
            }
        }
    };

    while alive.load(Ordering::SeqCst) {
        if !pending.is_empty() && last_data.elapsed() >= EMIT_COALESCE {
            flush(&mut pending);
        }

        let timeout_ms: i32 = if pending.is_empty() {
            // Nothing buffered — wait a bit for the next byte (or re-check alive).
            250
        } else {
            let left = EMIT_COALESCE.saturating_sub(last_data.elapsed());
            left.as_millis().min(i32::MAX as u128) as i32
        };

        let mut pfd = libc::pollfd {
            fd,
            events: libc::POLLIN,
            revents: 0,
        };
        let pr = unsafe { libc::poll(&mut pfd, 1, timeout_ms) };
        if pr < 0 {
            let err = std::io::Error::last_os_error();
            if err.kind() == std::io::ErrorKind::Interrupted {
                continue;
            }
            break;
        }
        if pr == 0 {
            // Idle timeout with pending → drain (the actual fix for whoami/…).
            if !pending.is_empty() && last_data.elapsed() >= EMIT_COALESCE {
                flush(&mut pending);
            }
            continue;
        }

        if pfd.revents & (libc::POLLERR | libc::POLLHUP | libc::POLLNVAL) != 0
            && pfd.revents & libc::POLLIN == 0
        {
            break;
        }

        match reader.read(&mut buf) {
            Ok(0) => break,
            Ok(n) => {
                pending.push_str(&String::from_utf8_lossy(&buf[..n]));
                last_data = Instant::now();
                if pending.len() >= EMIT_HIGH_WATER {
                    flush(&mut pending);
                }
            }
            Err(err) if err.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(err) if err.kind() == std::io::ErrorKind::WouldBlock => {
                if !pending.is_empty() && last_data.elapsed() >= EMIT_COALESCE {
                    flush(&mut pending);
                }
            }
            Err(_) => break,
        }
    }

    flush(&mut pending);
}

#[cfg(not(unix))]
fn host_pty_read_loop(
    reader: &mut Box<dyn Read + Send>,
    _fd: i32,
    alive: &AtomicBool,
    ring: &Mutex<Ring>,
    attachers: &Mutex<HashMap<ClientId, OutputTx>>,
    session_id: &str,
) {
    // Fallback: flush every read (no poll-based idle drain).
    let mut buf = [0u8; 8192];
    while alive.load(Ordering::SeqCst) {
        match reader.read(&mut buf) {
            Ok(0) => break,
            Ok(n) => {
                let chunk = String::from_utf8_lossy(&buf[..n]).into_owned();
                if let Ok(mut r) = ring.lock() {
                    r.push_str(&chunk);
                }
                let ev = Event {
                    event: "session.output".into(),
                    params: json!({ "sessionId": session_id, "chunk": chunk }),
                };
                if let Ok(line) = serde_json::to_string(&ev) {
                    if let Ok(mut map) = attachers.lock() {
                        for tx in map.values() {
                            let _ = tx.send(ClientMsg::Line(line.clone()));
                        }
                    }
                }
            }
            Err(err) if err.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(_) => break,
        }
    }
}

fn create_session(state: &Arc<Mutex<HostState>>, p: CreateParams) -> Result<SessionSummary, String> {
    let mut guard = state.lock().map_err(|e| e.to_string())?;
    if guard.sessions.contains_key(&p.session_id) {
        // Re-create is attach-friendly: destroy old first.
        drop(guard);
        let _ = destroy_session(state, &p.session_id);
        guard = state.lock().map_err(|e| e.to_string())?;
    }

    let cols = p.cols.unwrap_or(120);
    let rows = p.rows.unwrap_or(40);
    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| format!("openpty: {e}"))?;

    let cwd = PathBuf::from(&p.cwd);
    let mut cmd = CommandBuilder::new(&p.shell);
    // Login interactive where appropriate.
    let base = Path::new(&p.shell)
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("");
    if base.contains("zsh") || base.contains("bash") || base.contains("fish") {
        cmd.arg("-l");
        cmd.arg("-i");
    }
    if cwd.is_dir() {
        cmd.cwd(&cwd);
    }
    if cmd.get_env("TERM").is_none() {
        cmd.env("TERM", "xterm-256color");
    }
    if cmd.get_env("COLORTERM").is_none() {
        cmd.env("COLORTERM", "truecolor");
    }

    let mut child = pair
        .slave
        .spawn_command(cmd)
        .map_err(|e| format!("spawn shell: {e}"))?;
    let pid = child.process_id().unwrap_or(0);
    let killer = child.clone_killer();

    let writer = pair
        .master
        .take_writer()
        .map_err(|e| format!("pty writer: {e}"))?;
    let mut reader = pair
        .master
        .try_clone_reader()
        .map_err(|e| format!("pty reader: {e}"))?;

    #[cfg(unix)]
    let master_fd: RawFd = pair
        .master
        .as_raw_fd()
        .ok_or_else(|| "PTY master has no raw fd".to_string())?;
    #[cfg(not(unix))]
    let master_fd: i32 = -1;

    let alive = Arc::new(AtomicBool::new(true));
    let ring = Arc::new(Mutex::new(Ring::new(RING_MAX)));
    let attachers: Arc<Mutex<HashMap<ClientId, OutputTx>>> = Arc::new(Mutex::new(HashMap::new()));
    let master = Arc::new(Mutex::new(pair.master));
    let writer = Arc::new(Mutex::new(writer));

    let sess = Arc::new(HostSession {
        session_id: p.session_id.clone(),
        shell: p.shell.clone(),
        cwd: cwd.clone(),
        pid,
        alive: Arc::clone(&alive),
        writer: Arc::clone(&writer),
        master: Arc::clone(&master),
        ring: Arc::clone(&ring),
        attachers: Arc::clone(&attachers),
        last_activity: Mutex::new(None),
        _child_killer: Mutex::new(killer),
    });

    // Reader thread: drain into ring + fanout. Must idle-flush small output
    // (blocking read alone never flushes whoami-sized chunks).
    let sid = p.session_id.clone();
    let alive_r = Arc::clone(&alive);
    let ring_r = Arc::clone(&ring);
    let attachers_r = Arc::clone(&attachers);
    thread::Builder::new()
        .name(format!("host-pty-{sid}"))
        .spawn(move || {
            host_pty_read_loop(
                &mut reader,
                master_fd,
                &alive_r,
                &ring_r,
                &attachers_r,
                &sid,
            );
            alive_r.store(false, Ordering::SeqCst);
            let ev = Event {
                event: "session.exit".into(),
                params: json!({ "sessionId": sid, "code": null }),
            };
            if let Ok(line) = serde_json::to_string(&ev) {
                if let Ok(map) = attachers_r.lock() {
                    for tx in map.values() {
                        let _ = tx.send(ClientMsg::Line(line.clone()));
                    }
                }
            }
            // Keep child wait from zombie-ing.
            let _ = child.wait();
        })
        .map_err(|e| format!("reader thread: {e}"))?;

    let summary = SessionSummary {
        session_id: p.session_id.clone(),
        shell: p.shell,
        cwd: cwd.display().to_string(),
        pid,
        alive: true,
    };
    guard.sessions.insert(p.session_id, sess);
    Ok(summary)
}

fn attach_session(
    state: &Arc<Mutex<HostState>>,
    session_id: &str,
    client_id: ClientId,
    tx: OutputTx,
) -> Result<String, String> {
    let guard = state.lock().map_err(|e| e.to_string())?;
    let sess = guard
        .sessions
        .get(session_id)
        .ok_or_else(|| format!("unknown session: {session_id}"))?
        .clone();
    drop(guard);

    let replay = sess
        .ring
        .lock()
        .map(|r| r.snapshot())
        .unwrap_or_default();
    sess.attachers
        .lock()
        .map_err(|e| e.to_string())?
        .insert(client_id, tx);
    Ok(replay)
}

fn detach_client(state: &Arc<Mutex<HostState>>, session_id: &str, client_id: ClientId) {
    let Ok(guard) = state.lock() else {
        return;
    };
    if let Some(sess) = guard.sessions.get(session_id) {
        if let Ok(mut map) = sess.attachers.lock() {
            map.remove(&client_id);
        }
    }
}

fn write_session(state: &Arc<Mutex<HostState>>, session_id: &str, bytes: &[u8]) -> Result<(), String> {
    let guard = state.lock().map_err(|e| e.to_string())?;
    let sess = guard
        .sessions
        .get(session_id)
        .ok_or_else(|| format!("unknown session: {session_id}"))?
        .clone();
    drop(guard);
    let mut w = sess.writer.lock().map_err(|e| e.to_string())?;
    w.write_all(bytes).map_err(|e| format!("write: {e}"))?;
    w.flush().map_err(|e| format!("flush: {e}"))
}

fn resize_session(
    state: &Arc<Mutex<HostState>>,
    session_id: &str,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    let guard = state.lock().map_err(|e| e.to_string())?;
    let sess = guard
        .sessions
        .get(session_id)
        .ok_or_else(|| format!("unknown session: {session_id}"))?
        .clone();
    drop(guard);
    let master = sess.master.lock().map_err(|e| e.to_string())?;
    master
        .resize(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| format!("resize: {e}"))
}

fn destroy_session(state: &Arc<Mutex<HostState>>, session_id: &str) -> Result<(), String> {
    let sess = {
        let mut guard = state.lock().map_err(|e| e.to_string())?;
        guard
            .sessions
            .remove(session_id)
            .ok_or_else(|| format!("unknown session: {session_id}"))?
    };
    sess.alive.store(false, Ordering::SeqCst);
    if let Ok(mut k) = sess._child_killer.lock() {
        let _ = k.kill();
    }
    // Drop writer/master by dropping sess.
    drop(sess);
    Ok(())
}

/// Is a host already listening?
pub fn host_seems_alive() -> bool {
    #[cfg(unix)]
    {
        let sock = host_protocol::socket_path();
        if !sock.exists() {
            return false;
        }
        UnixStream::connect(&sock).is_ok()
    }
    #[cfg(not(unix))]
    {
        false
    }
}

/// Spawn `chatty-host` detached if needed. Returns socket path.
pub fn ensure_host_process(host_bin: &Path) -> Result<PathBuf, String> {
    if host_seems_alive() {
        return Ok(host_protocol::socket_path());
    }
    let dir = host_protocol::runtime_dir();
    std::fs::create_dir_all(&dir).map_err(|e| format!("runtime dir: {e}"))?;

    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        let mut cmd = Command::new(host_bin);
        cmd.arg("serve")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        // Detach from controlling terminal / session so UI quit doesn't kill host.
        unsafe {
            cmd.pre_exec(|| {
                if libc::setsid() == -1 {
                    return Err(std::io::Error::last_os_error());
                }
                Ok(())
            });
        }
        let child: Child = cmd.spawn().map_err(|e| format!("spawn chatty-host: {e}"))?;
        // Don't wait; host runs independently.
        std::mem::forget(child);

        // Wait briefly for socket.
        for _ in 0..50 {
            thread::sleep(Duration::from_millis(50));
            if host_seems_alive() {
                return Ok(host_protocol::socket_path());
            }
        }
        Err("chatty-host did not become ready in time".into())
    }

    #[cfg(not(unix))]
    {
        let _ = host_bin;
        Err("ensure_host_process: Unix only in this build".into())
    }
}
