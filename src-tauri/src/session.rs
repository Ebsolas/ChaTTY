//! Session management: interactive PTY (terminal) + shell-agnostic exec (chat).

use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

#[cfg(unix)]
use std::os::fd::RawFd;

use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};
use uuid::Uuid;

use crate::shell::{self, ShellFlavor};

pub const DEFAULT_SESSION_NAME: &str = "local";
/// Soft cap for concurrent interactive shells (MVP2 multi-session).
const MAX_SESSIONS: usize = 16;
/// Prefix for tmux session names on the Chatty host (never on SSH remotes).
const TMUX_NAME_PREFIX: &str = "chatty_";

const DEFAULT_ROWS: u16 = 40;
const DEFAULT_COLS: u16 = 120;
/// Batch PTY output for this long after the last byte, then flush even if
/// no further data arrives (idle drain). Fixes "output stuck until next key".
const EMIT_COALESCE: Duration = Duration::from_millis(16);
/// Flush immediately under burst so UI stays responsive.
const EMIT_HIGH_WATER: usize = 4096;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum SessionStatus {
    Running,
    Exited,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum SessionBackend {
    /// Outer PTY runs `tmux new-session -A` (durable on Chatty host).
    Tmux,
    /// Outer PTY runs the shell directly (no reattach after quit).
    Plain,
}

impl SessionBackend {
    pub fn as_str(self) -> &'static str {
        match self {
            SessionBackend::Tmux => "tmux",
            SessionBackend::Plain => "plain",
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionInfo {
    pub id: String,
    pub name: String,
    pub status: SessionStatus,
    pub cwd: String,
    pub shell: String,
    pub shell_flavor: String,
    /// How this session is hosted: "tmux" | "plain".
    pub backend: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionOutputEvent {
    pub session_id: String,
    pub chunk: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionStatusEvent {
    pub session_id: String,
    pub status: SessionStatus,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionExitEvent {
    pub session_id: String,
    pub code: Option<u32>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionRemovedEvent {
    pub session_id: String,
}

/// Process-level activity from tmux pane_current_command (host-local).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum PaneActivity {
    Idle,
    Busy,
    Tui,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionActivityEvent {
    pub session_id: String,
    pub activity: PaneActivity,
    /// Foreground process name from tmux, if any.
    pub command: String,
    pub cwd: String,
}

/// Full session snapshot after rename (same shape as SessionInfo).
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionRenamedEvent {
    pub id: String,
    pub name: String,
    pub status: SessionStatus,
    pub cwd: String,
    pub shell: String,
    pub shell_flavor: String,
}

/// Chat turn streaming (exec path).
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunOutputEvent {
    pub session_id: String,
    pub turn_id: String,
    pub chunk: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunFinishedEvent {
    pub session_id: String,
    pub turn_id: String,
    pub code: i32,
    pub cwd: String,
}

pub(crate) struct InteractivePty {
    writer: Mutex<Box<dyn Write + Send>>,
    master: Mutex<Box<dyn MasterPty + Send>>,
    alive: Arc<AtomicBool>,
    killer: Mutex<Box<dyn ChildKiller + Send + Sync>>,
}

struct LiveSession {
    id: String,
    name: String,
    status: SessionStatus,
    cwd: PathBuf,
    shell: String,
    flavor: ShellFlavor,
    backend: SessionBackend,
    /// tmux session name on this host when backend is Tmux.
    tmux_name: Option<String>,
    /// Last polled foreground command (dedupe activity events).
    last_poll_cmd: Option<String>,
    last_poll_path: Option<String>,
    /// Whether we already forced `status off` on this tmux session.
    tmux_status_off: bool,
    /// Optional interactive terminal backend.
    pty: Option<InteractivePty>,
}

pub struct SessionManager {
    sessions: HashMap<String, LiveSession>,
    max_sessions: usize,
    /// Stable order for UI (create order), not alphabetical.
    order: Vec<String>,
}

impl SessionManager {
    pub fn new() -> Self {
        Self {
            sessions: HashMap::new(),
            max_sessions: MAX_SESSIONS,
            order: Vec::new(),
        }
    }

    pub fn list(&self) -> Vec<SessionInfo> {
        let mut list: Vec<_> = self
            .order
            .iter()
            .filter_map(|id| self.sessions.get(id).map(session_info))
            .collect();
        // Any sessions missing from order (shouldn't happen) still appear.
        for s in self.sessions.values() {
            if !self.order.iter().any(|id| id == &s.id) {
                list.push(session_info(s));
            }
        }
        list
    }

    pub fn get_default_id(&self) -> Option<String> {
        self.sessions
            .values()
            .find(|s| s.name == DEFAULT_SESSION_NAME)
            .map(|s| s.id.clone())
            .or_else(|| self.order.first().cloned())
            .or_else(|| self.sessions.keys().next().cloned())
    }

    fn name_taken(&self, name: &str) -> bool {
        self.sessions
            .values()
            .any(|s| s.name.eq_ignore_ascii_case(name))
    }

    fn name_taken_by_other(&self, name: &str, except_id: &str) -> bool {
        self.sessions
            .values()
            .any(|s| s.id != except_id && s.name.eq_ignore_ascii_case(name))
    }

    /// Rename a session. Names are sanitized for @mentions and must be unique.
    pub fn rename(
        &mut self,
        app: &AppHandle,
        session_id: &str,
        new_name: &str,
    ) -> Result<SessionInfo, String> {
        let name = sanitize_session_name(new_name);
        if name.is_empty() {
            return Err("name cannot be empty (use letters, numbers, . _ -)".into());
        }
        if self.name_taken_by_other(&name, session_id) {
            return Err(format!("@{name} is already in use"));
        }

        let live = self
            .sessions
            .get_mut(session_id)
            .ok_or_else(|| format!("unknown session: {session_id}"))?;

        if live.name == name {
            return Ok(session_info(live));
        }

        live.name = name;
        let info = session_info(live);
        let _ = app.emit(
            "session-renamed",
            SessionRenamedEvent {
                id: info.id.clone(),
                name: info.name.clone(),
                status: info.status,
                cwd: info.cwd.clone(),
                shell: info.shell.clone(),
                shell_flavor: info.shell_flavor.clone(),
            },
        );
        Ok(info)
    }

    /// Allocate a unique session name. Preferred base is used if free;
    /// otherwise `base`, `base-2`, `base-3`, …
    fn allocate_name(&self, preferred: Option<String>) -> String {
        let base = preferred
            .map(|n| sanitize_session_name(&n))
            .filter(|n| !n.is_empty())
            .unwrap_or_else(|| DEFAULT_SESSION_NAME.to_string());

        if !self.name_taken(&base) {
            return base;
        }
        for n in 2..=self.max_sessions.saturating_mul(4).max(64) {
            let candidate = format!("{base}-{n}");
            if !self.name_taken(&candidate) {
                return candidate;
            }
        }
        format!("{base}-{}", Uuid::new_v4().simple())
    }

    /// Reserve a session slot and unique name (PTY not ready yet).
    /// Keeps the manager lock short so other sessions stay responsive.
    ///
    /// `fixed_id` / `preferred_cwd` are used when restoring saved sessions.
    pub fn begin_create(
        &mut self,
        app: &AppHandle,
        name: Option<String>,
        fixed_id: Option<String>,
        preferred_cwd: Option<String>,
    ) -> Result<SessionInfo, String> {
        if self.sessions.len() >= self.max_sessions {
            return Err(format!(
                "session limit reached ({})",
                self.max_sessions
            ));
        }

        let name = self.allocate_name(name);
        let id = match fixed_id {
            Some(s) => {
                let s = s.trim().to_string();
                if s.is_empty() {
                    Uuid::new_v4().to_string()
                } else if self.sessions.contains_key(&s) {
                    return Err(format!("session id already exists: {s}"));
                } else {
                    s
                }
            }
            None => Uuid::new_v4().to_string(),
        };

        let shell = shell::resolve_shell();
        let flavor = ShellFlavor::detect(&shell);
        let cwd = preferred_cwd
            .map(PathBuf::from)
            .filter(|p| p.is_dir())
            .unwrap_or_else(shell::default_cwd);

        let (backend, tmux_name) = if tmux_available() {
            (SessionBackend::Tmux, Some(tmux_session_name(&id)))
        } else {
            (SessionBackend::Plain, None)
        };

        let live = LiveSession {
            id: id.clone(),
            name,
            status: SessionStatus::Running,
            cwd,
            shell,
            flavor,
            backend,
            tmux_name,
            last_poll_cmd: None,
            last_poll_path: None,
            tmux_status_off: false,
            pty: None,
        };

        let info = session_info(&live);
        self.order.push(id.clone());
        self.sessions.insert(id.clone(), live);

        // Emit early so the UI can paint the rail before fork/exec finishes.
        let _ = app.emit(
            "session-created",
            info.clone(),
        );
        let _ = app.emit(
            "session-status",
            SessionStatusEvent {
                session_id: id,
                status: SessionStatus::Running,
            },
        );
        Ok(info)
    }

    /// Attach a spawned PTY to a reserved session.
    pub fn finish_create(
        &mut self,
        session_id: &str,
        pty: InteractivePty,
    ) -> Result<SessionInfo, String> {
        let live = self
            .sessions
            .get_mut(session_id)
            .ok_or_else(|| format!("unknown session: {session_id}"))?;
        live.pty = Some(pty);
        Ok(session_info(live))
    }

    /// Roll back a failed spawn (slot reserved but PTY never attached).
    pub fn abort_create(&mut self, app: &AppHandle, session_id: &str) {
        if self.sessions.remove(session_id).is_none() {
            return;
        }
        self.order.retain(|id| id != session_id);
        let _ = app.emit(
            "session-removed",
            SessionRemovedEvent {
                session_id: session_id.to_string(),
            },
        );
    }

    /// Destroy a session: kill durable tmux session (if any) + outer PTY client.
    /// App quit should NOT call this for every session — only detach the client.
    pub fn close(&mut self, app: &AppHandle, session_id: &str) -> Result<(), String> {
        let mut live = self
            .sessions
            .remove(session_id)
            .ok_or_else(|| format!("unknown session: {session_id}"))?;
        self.order.retain(|id| id != session_id);

        // Explicit close = user wants the session gone. tmux lives only on the
        // Chatty host (SSH remotes never need tmux).
        if let Some(ref tmux_name) = live.tmux_name {
            let _ = kill_tmux_session(tmux_name);
        }

        if let Some(pty) = live.pty.take() {
            pty.alive.store(false, Ordering::SeqCst);
            if let Ok(mut killer) = pty.killer.lock() {
                let _ = killer.kill();
            }
            // Drop writer/master so the PTY closes (SIGHUP if kill missed).
            drop(pty);
        }

        live.status = SessionStatus::Exited;
        let _ = app.emit(
            "session-status",
            SessionStatusEvent {
                session_id: session_id.to_string(),
                status: SessionStatus::Exited,
            },
        );
        let _ = app.emit(
            "session-removed",
            SessionRemovedEvent {
                session_id: session_id.to_string(),
            },
        );
        Ok(())
    }

    /// Shell-agnostic chat turn: spawn one process, stream output, finish on exit.
    pub fn run_command(
        &self,
        app: AppHandle,
        session_id: &str,
        command: &str,
    ) -> Result<String, String> {
        let session = self
            .sessions
            .get(session_id)
            .ok_or_else(|| format!("unknown session: {session_id}"))?;

        let command = command.trim_end().to_string();
        if command.is_empty() {
            return Err("empty command".into());
        }

        let turn_id = Uuid::new_v4().to_string();
        let session_id = session.id.clone();
        let cwd = session.cwd.clone();
        let shell = session.shell.clone();
        let flavor = session.flavor;
        let (program, args) = shell::exec_invocation(&shell, flavor, &command);

        let app_out = app.clone();
        let app_done = app.clone();
        let turn_out = turn_id.clone();
        let turn_done = turn_id.clone();
        let sid_out = session_id.clone();
        let sid_done = session_id.clone();
        let cmd_env = command.clone();

        thread::Builder::new()
            .name(format!("exec-{turn_id}"))
            .spawn(move || {
                let mut child = match Command::new(&program)
                    .args(&args)
                    .current_dir(&cwd)
                    .env("CHATTY_CMD", &cmd_env)
                    .stdout(Stdio::piped())
                    .stderr(Stdio::piped())
                    .stdin(Stdio::null())
                    .spawn()
                {
                    Ok(c) => c,
                    Err(e) => {
                        let _ = app_done.emit(
                            "run-output",
                            RunOutputEvent {
                                session_id: sid_done.clone(),
                                turn_id: turn_done.clone(),
                                chunk: format!("failed to spawn {program}: {e}\n"),
                            },
                        );
                        let _ = app_done.emit(
                            "run-finished",
                            RunFinishedEvent {
                                session_id: sid_done,
                                turn_id: turn_done,
                                code: 127,
                                cwd: cwd.to_string_lossy().into_owned(),
                            },
                        );
                        return;
                    }
                };

                let stdout = child.stdout.take();
                let stderr = child.stderr.take();

                let app_err = app_out.clone();
                let sid_err = sid_out.clone();
                let turn_err = turn_out.clone();
                let err_thread = thread::spawn(move || {
                    if let Some(mut err) = stderr {
                        let mut buf = [0u8; 4096];
                        loop {
                            match err.read(&mut buf) {
                                Ok(0) => break,
                                Ok(n) => {
                                    let chunk = String::from_utf8_lossy(&buf[..n]).into_owned();
                                    let _ = app_err.emit(
                                        "run-output",
                                        RunOutputEvent {
                                            session_id: sid_err.clone(),
                                            turn_id: turn_err.clone(),
                                            chunk,
                                        },
                                    );
                                }
                                Err(_) => break,
                            }
                        }
                    }
                });

                if let Some(mut out) = stdout {
                    let mut buf = [0u8; 4096];
                    loop {
                        match out.read(&mut buf) {
                            Ok(0) => break,
                            Ok(n) => {
                                let chunk = String::from_utf8_lossy(&buf[..n]).into_owned();
                                let _ = app_out.emit(
                                    "run-output",
                                    RunOutputEvent {
                                        session_id: sid_out.clone(),
                                        turn_id: turn_out.clone(),
                                        chunk,
                                    },
                                );
                            }
                            Err(_) => break,
                        }
                    }
                }

                let _ = err_thread.join();
                let code = match child.wait() {
                    Ok(status) => status.code().unwrap_or(1),
                    Err(_) => 1,
                };

                // Cwd update is applied on the frontend from the footer; we also
                // re-read nothing here — manager cwd is updated via set_cwd command.
                let _ = app_done.emit(
                    "run-finished",
                    RunFinishedEvent {
                        session_id: sid_done,
                        turn_id: turn_done,
                        code,
                        cwd: cwd.to_string_lossy().into_owned(),
                    },
                );
            })
            .map_err(|e| format!("spawn exec thread: {e}"))?;

        Ok(turn_id)
    }

    pub fn set_cwd(&mut self, session_id: &str, cwd: &str) -> Result<(), String> {
        let session = self
            .sessions
            .get_mut(session_id)
            .ok_or_else(|| format!("unknown session: {session_id}"))?;
        let path = PathBuf::from(cwd);
        if path.is_dir() {
            session.cwd = path;
            Ok(())
        } else {
            // Still store — remote/future; for local warn softly
            session.cwd = path;
            Ok(())
        }
    }

    pub fn send_raw(&self, session_id: &str, bytes: &[u8]) -> Result<(), String> {
        let session = self
            .sessions
            .get(session_id)
            .ok_or_else(|| format!("unknown session: {session_id}"))?;
        let pty = session
            .pty
            .as_ref()
            .ok_or_else(|| "session is still starting".to_string())?;
        if !pty.alive.load(Ordering::SeqCst) {
            return Err("session pty has exited".into());
        }
        let mut writer = pty
            .writer
            .lock()
            .map_err(|_| "pty writer lock poisoned".to_string())?;
        writer
            .write_all(bytes)
            .map_err(|e| format!("write pty: {e}"))?;
        writer.flush().map_err(|e| format!("flush pty: {e}"))?;
        Ok(())
    }

    pub fn resize(&self, session_id: &str, cols: u16, rows: u16) -> Result<(), String> {
        let session = self
            .sessions
            .get(session_id)
            .ok_or_else(|| format!("unknown session: {session_id}"))?;
        let pty = session
            .pty
            .as_ref()
            .ok_or_else(|| "session is still starting".to_string())?;
        if !pty.alive.load(Ordering::SeqCst) {
            return Err("session pty has exited".into());
        }
        let cols = cols.clamp(2, 500);
        let rows = rows.clamp(2, 200);
        let master = pty
            .master
            .lock()
            .map_err(|_| "pty master lock poisoned".to_string())?;
        master
            .resize(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| format!("resize pty: {e}"))
    }
}

fn session_info(s: &LiveSession) -> SessionInfo {
    SessionInfo {
        id: s.id.clone(),
        name: s.name.clone(),
        status: s.status,
        cwd: s.cwd.to_string_lossy().into_owned(),
        shell: s.shell.clone(),
        shell_flavor: s.flavor.as_str().to_string(),
        backend: s.backend.as_str().to_string(),
    }
}

/// Stable tmux session name for a Chatty session id (host-local only).
pub fn tmux_session_name(session_id: &str) -> String {
    let mut out = String::with_capacity(TMUX_NAME_PREFIX.len() + session_id.len());
    out.push_str(TMUX_NAME_PREFIX);
    for ch in session_id.chars() {
        if ch.is_ascii_alphanumeric() || ch == '_' || ch == '-' {
            out.push(ch);
        } else {
            out.push('_');
        }
    }
    if out.len() > 64 {
        out.truncate(64);
    }
    out
}

fn tmux_available() -> bool {
    find_tmux().is_some()
}

fn find_tmux() -> Option<PathBuf> {
    if let Ok(p) = std::env::var("CHATTY_TMUX") {
        let pb = PathBuf::from(p);
        if pb.is_file() {
            return Some(pb);
        }
    }
    for cand in [
        "/usr/bin/tmux",
        "/usr/local/bin/tmux",
        "/bin/tmux",
        "/opt/homebrew/bin/tmux",
    ] {
        let p = PathBuf::from(cand);
        if p.is_file() {
            return Some(p);
        }
    }
    match Command::new("tmux")
        .arg("-V")
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
    {
        Ok(st) if st.success() => Some(PathBuf::from("tmux")),
        _ => None,
    }
}

fn kill_tmux_session(tmux_name: &str) -> Result<(), String> {
    let tmux = find_tmux().ok_or_else(|| "tmux not found".to_string())?;
    let _ = Command::new(tmux)
        .args(["kill-session", "-t", tmux_name])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map_err(|e| format!("tmux kill-session: {e}"))?;
    Ok(())
}

/// Whether Chatty will host new sessions under tmux on this machine.
pub fn host_session_backend() -> SessionBackend {
    if tmux_available() {
        SessionBackend::Tmux
    } else {
        SessionBackend::Plain
    }
}

fn is_shell_command(cmd: &str, shell_path: &str) -> bool {
    let c = cmd.trim().to_ascii_lowercase();
    if c.is_empty() {
        return true;
    }
    const SHELLS: &[&str] = &[
        "zsh", "bash", "fish", "sh", "dash", "ksh", "csh", "tcsh", "nu", "pwsh", "powershell",
    ];
    if SHELLS.iter().any(|s| c == *s || c.ends_with(&format!("/{s}"))) {
        return true;
    }
    let base = std::path::Path::new(shell_path)
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    !base.is_empty() && (c == base || c.ends_with(&format!("/{base}")))
}

fn is_tui_command(cmd: &str) -> bool {
    let c = cmd.trim().to_ascii_lowercase();
    let base = c.rsplit('/').next().unwrap_or(&c);
    const TUIS: &[&str] = &[
        "vim", "nvim", "vi", "view", "vimdiff", "nvimdiff", "emacs", "nano", "micro", "helix",
        "kak", "htop", "btop", "top", "iotop", "nvitop", "less", "more", "most", "ranger",
        "lf", "nnn", "vifm", "mc", "lazygit", "tig", "gitui", "fzf", "fzy", "watch", "tmux",
        "screen", "man", "info",
    ];
    TUIS.iter().any(|t| base == *t)
}

fn classify_pane_command(cmd: &str, shell_path: &str) -> PaneActivity {
    if is_shell_command(cmd, shell_path) {
        PaneActivity::Idle
    } else if is_tui_command(cmd) {
        PaneActivity::Tui
    } else {
        PaneActivity::Busy
    }
}

struct TmuxPaneSnapshot {
    command: String,
    path: String,
    dead: bool,
}

/// Interpreters whose cmdline often holds the real program (e.g. python → ranger).
const INTERPRETERS: &[&str] = &[
    "python", "python2", "python3", "node", "nodejs", "perl", "ruby", "lua", "php", "bash", "sh",
    "zsh", "fish",
];

fn read_proc_comm(pid: i32) -> Option<String> {
    let s = std::fs::read_to_string(format!("/proc/{pid}/comm")).ok()?;
    Some(s.trim().to_string())
}

fn read_proc_cmdline(pid: i32) -> Option<String> {
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
        return None;
    }
    Some(parts.join(" "))
}

fn proc_children(pid: i32) -> Vec<i32> {
    let mut kids = Vec::new();
    let task_dir = format!("/proc/{pid}/task");
    let Ok(entries) = std::fs::read_dir(&task_dir) else {
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

fn basename_os(path: &str) -> &str {
    path.rsplit('/').next().unwrap_or(path)
}

/// Resolve a human command name from pane pid (handles `python /usr/bin/ranger`).
///
/// When tmux already reports a shell (idle), **trust that** — do not walk
/// children (async prompt helpers / gitstatus would false-busy the session).
fn resolve_display_command(pane_pid: i32, tmux_cmd: &str, shell_path: &str) -> String {
    use std::collections::VecDeque;

    let tmux_l = tmux_cmd.trim().to_ascii_lowercase();
    if is_shell_command(&tmux_l, shell_path) {
        return tmux_l;
    }

    let shells: std::collections::HashSet<&str> = [
        "zsh", "bash", "fish", "sh", "dash", "ksh", "csh", "tcsh", "nu", "tmux",
    ]
    .into_iter()
    .collect();

    let mut q = VecDeque::from([pane_pid]);
    let mut seen = std::collections::HashSet::new();

    while let Some(pid) = q.pop_front() {
        if !seen.insert(pid) {
            continue;
        }
        let comm = read_proc_comm(pid).unwrap_or_default();
        let cmdline = read_proc_cmdline(pid).unwrap_or_default();
        let comm_l = comm.to_ascii_lowercase();

        if !comm.is_empty() && !shells.contains(comm_l.as_str()) {
            // Interpreter wrappers: prefer script basename from cmdline.
            if INTERPRETERS
                .iter()
                .any(|i| comm_l == *i || comm_l.starts_with(&format!("{i}.")))
            {
                for tok in cmdline.split_whitespace() {
                    if tok.starts_with('-') {
                        continue;
                    }
                    let base = basename_os(tok).to_ascii_lowercase();
                    if base.is_empty()
                        || INTERPRETERS
                            .iter()
                            .any(|i| base == *i || base.starts_with(&format!("{i}.")))
                    {
                        continue;
                    }
                    if shells.contains(base.as_str()) {
                        continue;
                    }
                    return base;
                }
            }
            return comm_l;
        }

        for c in proc_children(pid) {
            q.push_back(c);
        }
    }

    tmux_l
}

fn query_tmux_pane(tmux_name: &str, shell_path: &str) -> Option<TmuxPaneSnapshot> {
    let tmux = find_tmux()?;
    let output = Command::new(tmux)
        .args([
            "list-panes",
            "-t",
            tmux_name,
            "-F",
            "#{pane_pid}\t#{pane_current_command}\t#{pane_current_path}\t#{pane_dead}",
        ])
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&output.stdout);
    let line = text.lines().next()?.trim();
    if line.is_empty() {
        return None;
    }
    let mut parts = line.splitn(4, '\t');
    let pid: i32 = parts.next().unwrap_or("0").parse().unwrap_or(0);
    let tmux_cmd = parts.next().unwrap_or("").to_string();
    let path = parts.next().unwrap_or("").to_string();
    let dead = parts.next().unwrap_or("0") == "1";
    let command = if pid > 0 {
        resolve_display_command(pid, &tmux_cmd, shell_path)
    } else {
        tmux_cmd.trim().to_ascii_lowercase()
    };
    Some(TmuxPaneSnapshot {
        command,
        path,
        dead,
    })
}

/// Poll all tmux-backed sessions and emit activity events when state changes.
///
/// Idle is re-emitted periodically even when the command string is unchanged so
/// the frontend can clear optimistic "busy" after fast commands (poll never
/// observed a non-shell process).
pub fn poll_tmux_activity(app: &AppHandle, mgr: &mut SessionManager) {
    let targets: Vec<(String, String, String)> = mgr
        .sessions
        .values()
        .filter(|s| s.backend == SessionBackend::Tmux)
        .filter_map(|s| {
            s.tmux_name
                .as_ref()
                .map(|n| (s.id.clone(), n.clone(), s.shell.clone()))
        })
        .collect();

    for (session_id, tmux_name, shell) in targets {
        // Once per session: strip green status bar (existing sessions predate conf).
        let needs_status_off = mgr
            .sessions
            .get(&session_id)
            .map(|s| !s.tmux_status_off)
            .unwrap_or(true);
        if needs_status_off {
            ensure_tmux_status_off(&tmux_name);
            if let Some(live) = mgr.sessions.get_mut(&session_id) {
                live.tmux_status_off = true;
            }
        }

        let Some(snap) = query_tmux_pane(&tmux_name, &shell) else {
            continue;
        };
        if snap.dead {
            continue;
        }
        let activity = classify_pane_command(&snap.command, &shell);
        let prev_cmd = mgr
            .sessions
            .get(&session_id)
            .and_then(|s| s.last_poll_cmd.clone());
        let prev_path = mgr
            .sessions
            .get(&session_id)
            .and_then(|s| s.last_poll_path.clone());
        let cmd_changed = prev_cmd.as_ref().map(|c| c != &snap.command).unwrap_or(true);
        let path_changed = prev_path.as_ref().map(|p| p != &snap.path).unwrap_or(true);

        let prev_activity = prev_cmd
            .as_ref()
            .map(|c| classify_pane_command(c, &shell));
        let activity_changed = prev_activity.map(|a| a != activity).unwrap_or(true);

        // Always re-emit Idle (and Tui) so UI can recover from optimistic busy.
        // Busy only needs emit on change (otherwise spam while builds run).
        let should_emit = cmd_changed
            || path_changed
            || activity_changed
            || activity == PaneActivity::Idle
            || activity == PaneActivity::Tui;

        if !should_emit {
            continue;
        }

        if let Some(live) = mgr.sessions.get_mut(&session_id) {
            live.last_poll_cmd = Some(snap.command.clone());
            if !snap.path.is_empty() {
                live.last_poll_path = Some(snap.path.clone());
                let p = PathBuf::from(&snap.path);
                if p.is_dir() {
                    live.cwd = p;
                }
            }
        }

        let cwd = mgr
            .sessions
            .get(&session_id)
            .map(|s| s.cwd.to_string_lossy().into_owned())
            .unwrap_or_default();

        let _ = app.emit(
            "session-activity",
            SessionActivityEvent {
                session_id,
                activity,
                command: snap.command,
                cwd,
            },
        );
    }
}

/// Background poller: process truth from host-local tmux.
pub fn start_activity_poller(app: AppHandle) {
    thread::Builder::new()
        .name("chatty-tmux-poll".into())
        .spawn(move || {
            loop {
                thread::sleep(Duration::from_millis(350));
                let state = app.try_state::<AppState>();
                let Some(state) = state else {
                    continue;
                };
                let Ok(mut mgr) = state.sessions.lock() else {
                    continue;
                };
                poll_tmux_activity(&app, &mut mgr);
            }
        })
        .ok();
}

/// Session names for @mentions: alphanumeric, `.`, `_`, `-`.
fn sanitize_session_name(raw: &str) -> String {
    let trimmed = raw.trim();
    let mut out = String::with_capacity(trimmed.len());
    for ch in trimmed.chars() {
        if ch.is_ascii_alphanumeric() || ch == '.' || ch == '_' || ch == '-' {
            out.push(ch.to_ascii_lowercase());
        } else if ch.is_whitespace() {
            if !out.ends_with('-') {
                out.push('-');
            }
        }
    }
    out.trim_matches('-').to_string()
}

/// Coalesce PTY reads, but **always drain on idle** so the last command's
/// output is not stuck until the next keypress triggers another read.
#[cfg(unix)]
fn pty_read_loop_coalesce_drain(
    reader: &mut Box<dyn Read + Send>,
    fd: RawFd,
    alive: &AtomicBool,
    app: &AppHandle,
    session_id: &str,
) {
    let mut buf = [0u8; 8192];
    let mut pending = String::new();
    let mut last_data = Instant::now();

    let flush = |pending: &mut String, app: &AppHandle, session_id: &str| {
        if pending.is_empty() {
            return;
        }
        let chunk = std::mem::take(pending);
        let _ = app.emit(
            "session-output",
            SessionOutputEvent {
                session_id: session_id.to_string(),
                chunk,
            },
        );
    };

    while alive.load(Ordering::SeqCst) {
        // If we have pending data past the coalesce window, flush before blocking.
        if !pending.is_empty() && last_data.elapsed() >= EMIT_COALESCE {
            flush(&mut pending, app, session_id);
        }

        let timeout_ms: i32 = if pending.is_empty() {
            // Nothing buffered — wait indefinitely for the next byte (or 250ms
            // to re-check `alive`).
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
            // Idle timeout with pending → drain (the actual fix).
            if !pending.is_empty() && last_data.elapsed() >= EMIT_COALESCE {
                flush(&mut pending, app, session_id);
            }
            continue;
        }

        // Readable (or hangup/error)
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
                    flush(&mut pending, app, session_id);
                }
            }
            Err(err) if err.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(err) if err.kind() == std::io::ErrorKind::WouldBlock => {
                if !pending.is_empty() && last_data.elapsed() >= EMIT_COALESCE {
                    flush(&mut pending, app, session_id);
                }
            }
            Err(_) => break,
        }
    }

    flush(&mut pending, app, session_id);
}

#[cfg(not(unix))]
fn pty_read_loop_coalesce_drain(
    reader: &mut Box<dyn Read + Send>,
    _fd: i32,
    alive: &AtomicBool,
    app: &AppHandle,
    session_id: &str,
) {
    // Fallback: always flush each read (Windows path later can use ConPTY timeouts).
    let mut buf = [0u8; 8192];
    while alive.load(Ordering::SeqCst) {
        match reader.read(&mut buf) {
            Ok(0) => break,
            Ok(n) => {
                let chunk = String::from_utf8_lossy(&buf[..n]).into_owned();
                let _ = app.emit(
                    "session-output",
                    SessionOutputEvent {
                        session_id: session_id.to_string(),
                        chunk,
                    },
                );
            }
            Err(err) if err.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(_) => break,
        }
    }
}

/// Spawn login interactive PTY (blocking). Call from a worker thread.
/// Prefer host-local tmux so sessions survive Chatty quit (remote SSH never needs tmux).
pub(crate) fn spawn_interactive_pty_public(
    app: &AppHandle,
    session_id: &str,
    shell: &str,
    cwd: &PathBuf,
) -> Result<InteractivePty, String> {
    spawn_interactive_pty(app, session_id, shell, cwd)
}

fn apply_common_env(cmd: &mut CommandBuilder, shell: &str) {
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");
    if cmd.get_env("HOME").is_none() {
        if let Ok(home) = std::env::var("HOME") {
            cmd.env("HOME", home);
        }
    }
    if cmd.get_env("USER").is_none() {
        if let Ok(user) = std::env::var("USER") {
            cmd.env("USER", user);
        }
    }
    if cmd.get_env("LANG").is_none() {
        cmd.env("LANG", "en_US.UTF-8");
    }
    if cmd.get_env("SHELL").is_none() {
        cmd.env("SHELL", shell);
    }
}

fn shell_login_args(shell: &str) -> Vec<String> {
    let base = std::path::Path::new(shell)
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("");
    if base.contains("zsh") || base.contains("bash") || base.contains("fish") {
        vec!["-l".into(), "-i".into()]
    } else {
        Vec::new()
    }
}

/// Hide the default green status bar for a Chatty-owned tmux session only
/// (`set -t` is session-scoped — does not touch the user's other tmux sessions).
fn ensure_tmux_status_off(tmux_name: &str) {
    let Some(tmux) = find_tmux() else {
        return;
    };
    let _ = Command::new(&tmux)
        .args(["set-option", "-t", tmux_name, "status", "off"])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status();
    // Also clear window status / titles noise that redraws the client.
    let _ = Command::new(&tmux)
        .args(["set-option", "-t", tmux_name, "set-titles", "off"])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status();
}

/// Build the PTY child command: tmux new-session -A when available, else bare shell.
fn build_session_command(
    session_id: &str,
    shell: &str,
    cwd: &PathBuf,
) -> Result<(CommandBuilder, SessionBackend), String> {
    let login_args = shell_login_args(shell);

    if let Some(tmux) = find_tmux() {
        let name = tmux_session_name(session_id);
        // Existing sessions: strip status bar before the client attaches.
        // New sessions: this no-ops until after spawn (poller / post-spawn fix it).
        ensure_tmux_status_off(&name);

        let mut cmd = CommandBuilder::new(&tmux);
        // Host-local conf (status off). Never used on SSH remotes.
        // Note: -f only applies when this starts the tmux *server*; session-scoped
        // set-option is the reliable path for an already-running server.
        if let Ok(conf) = crate::config::ensure_tmux_conf() {
            cmd.arg("-f");
            cmd.arg(conf.as_os_str());
        }
        // -A: attach if exists (restore), else create.
        cmd.arg("new-session");
        cmd.arg("-A");
        cmd.arg("-s");
        cmd.arg(&name);
        cmd.arg("-c");
        cmd.arg(cwd.as_os_str());
        cmd.env("TMUX", "");
        cmd.arg("--");
        cmd.arg(shell);
        for a in &login_args {
            cmd.arg(a);
        }
        apply_common_env(&mut cmd, shell);
        cmd.cwd(cwd);
        return Ok((cmd, SessionBackend::Tmux));
    }

    // Plain fallback — no reattach after Chatty quit.
    let mut cmd = CommandBuilder::new(shell);
    for a in &login_args {
        cmd.arg(a);
    }
    cmd.cwd(cwd);
    apply_common_env(&mut cmd, shell);
    Ok((cmd, SessionBackend::Plain))
}

fn spawn_interactive_pty(
    app: &AppHandle,
    session_id: &str,
    shell: &str,
    cwd: &PathBuf,
) -> Result<InteractivePty, String> {
    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(PtySize {
            rows: DEFAULT_ROWS,
            cols: DEFAULT_COLS,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| format!("open pty: {e}"))?;

    let (cmd, backend) = build_session_command(session_id, shell, cwd)?;
    let label = match backend {
        SessionBackend::Tmux => format!("tmux+{shell}"),
        SessionBackend::Plain => shell.to_string(),
    };

    let mut child = pair
        .slave
        .spawn_command(cmd)
        .map_err(|e| format!("spawn interactive session ({label}): {e}"))?;

    // New sessions inherit global status=on; force off after the session exists.
    if backend == SessionBackend::Tmux {
        let name = tmux_session_name(session_id);
        // Brief delay so new-session finishes creating before set-option.
        thread::spawn(move || {
            thread::sleep(Duration::from_millis(80));
            ensure_tmux_status_off(&name);
            thread::sleep(Duration::from_millis(200));
            ensure_tmux_status_off(&name);
        });
    }

    let killer = child.clone_killer();

    #[cfg(unix)]
    let master_fd = pair
        .master
        .as_raw_fd()
        .ok_or_else(|| "PTY master has no raw fd".to_string())?;
    #[cfg(not(unix))]
    let master_fd: i32 = -1;

    let mut reader = pair
        .master
        .try_clone_reader()
        .map_err(|e| format!("clone pty reader: {e}"))?;
    let writer = pair
        .master
        .take_writer()
        .map_err(|e| format!("take pty writer: {e}"))?;

    let alive = Arc::new(AtomicBool::new(true));
    let alive_reader = Arc::clone(&alive);
    let alive_waiter = Arc::clone(&alive);
    let sid_reader = session_id.to_string();
    let sid_waiter = session_id.to_string();
    let app_reader = app.clone();
    let app_waiter = app.clone();

    thread::Builder::new()
        .name(format!("pty-read-{session_id}"))
        .spawn(move || {
            pty_read_loop_coalesce_drain(
                &mut reader,
                master_fd,
                &alive_reader,
                &app_reader,
                &sid_reader,
            );
        })
        .map_err(|e| format!("pty reader thread: {e}"))?;

    thread::Builder::new()
        .name(format!("pty-wait-{session_id}"))
        .spawn(move || {
            let code = match child.wait() {
                Ok(status) => status.exit_code(),
                Err(_) => 1,
            };
            alive_waiter.store(false, Ordering::SeqCst);
            // Only emit exit if the session is still tracked; close() already
            // removes it and emits session-removed. Double exit is harmless
            // for status, but we still notify for natural shell exit.
            let _ = app_waiter.emit(
                "session-status",
                SessionStatusEvent {
                    session_id: sid_waiter.clone(),
                    status: SessionStatus::Exited,
                },
            );
            let _ = app_waiter.emit(
                "session-exit",
                SessionExitEvent {
                    session_id: sid_waiter,
                    code: Some(code),
                },
            );
        })
        .map_err(|e| format!("pty wait thread: {e}"))?;

    Ok(InteractivePty {
        writer: Mutex::new(writer),
        master: Mutex::new(pair.master),
        alive,
        killer: Mutex::new(killer),
    })
}

pub struct AppState {
    pub sessions: Mutex<SessionManager>,
}

impl AppState {
    pub fn new() -> Self {
        Self {
            sessions: Mutex::new(SessionManager::new()),
        }
    }
}
