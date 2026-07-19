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

use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use tauri::{AppHandle, Emitter};
use uuid::Uuid;

use crate::shell::{self, ShellFlavor};

pub const DEFAULT_SESSION_NAME: &str = "local";

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

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionInfo {
    pub id: String,
    pub name: String,
    pub status: SessionStatus,
    pub cwd: String,
    pub shell: String,
    pub shell_flavor: String,
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

struct InteractivePty {
    writer: Mutex<Box<dyn Write + Send>>,
    master: Mutex<Box<dyn MasterPty + Send>>,
    alive: Arc<AtomicBool>,
}

struct LiveSession {
    id: String,
    name: String,
    status: SessionStatus,
    cwd: PathBuf,
    shell: String,
    flavor: ShellFlavor,
    /// Optional interactive terminal backend.
    pty: Option<InteractivePty>,
}

pub struct SessionManager {
    sessions: HashMap<String, LiveSession>,
    max_sessions: usize,
}

impl SessionManager {
    pub fn new() -> Self {
        Self {
            sessions: HashMap::new(),
            max_sessions: 1,
        }
    }

    pub fn list(&self) -> Vec<SessionInfo> {
        let mut list: Vec<_> = self.sessions.values().map(session_info).collect();
        list.sort_by(|a, b| a.name.cmp(&b.name));
        list
    }

    pub fn get_default_id(&self) -> Option<String> {
        self.sessions
            .values()
            .find(|s| s.name == DEFAULT_SESSION_NAME)
            .map(|s| s.id.clone())
            .or_else(|| self.sessions.keys().next().cloned())
    }

    pub fn create(
        &mut self,
        app: AppHandle,
        name: Option<String>,
    ) -> Result<SessionInfo, String> {
        if self.sessions.len() >= self.max_sessions {
            if let Some(existing) = self.sessions.values().next() {
                return Ok(session_info(existing));
            }
        }

        let name = name
            .map(|n| n.trim().to_string())
            .filter(|n| !n.is_empty())
            .unwrap_or_else(|| DEFAULT_SESSION_NAME.to_string());

        let id = Uuid::new_v4().to_string();
        let shell = shell::resolve_shell();
        let flavor = ShellFlavor::detect(&shell);
        let cwd = shell::default_cwd();

        // Interactive PTY for terminal expand (not used for chat R/R).
        let pty = spawn_interactive_pty(&app, &id, &shell, &cwd)?;

        let live = LiveSession {
            id: id.clone(),
            name,
            status: SessionStatus::Running,
            cwd,
            shell,
            flavor,
            pty: Some(pty),
        };

        let info = session_info(&live);
        let _ = app.emit(
            "session-status",
            SessionStatusEvent {
                session_id: id.clone(),
                status: SessionStatus::Running,
            },
        );
        self.sessions.insert(id, live);
        Ok(info)
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
                    .env("CHATTERM_CMD", &cmd_env)
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
            .ok_or_else(|| "no interactive pty for session".to_string())?;
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
            .ok_or_else(|| "no interactive pty for session".to_string())?;
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
    }
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

    let mut cmd = CommandBuilder::new(shell);
    let base = std::path::Path::new(shell)
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("");
    // Login + interactive so .zprofile/.zlogin and .zshrc (fastfetch, omz, etc.) load
    // the same way as a normal terminal emulator.
    if base.contains("zsh") || base.contains("bash") {
        cmd.arg("-l");
        cmd.arg("-i");
    } else if base.contains("fish") {
        cmd.arg("-l");
        cmd.arg("-i");
    }
    cmd.cwd(cwd);

    // GUI-launched apps often lack a proper TERM; shells and tools (fastfetch,
    // starship, colors) misbehave without it.
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

    let mut child = pair
        .slave
        .spawn_command(cmd)
        .map_err(|e| format!("spawn interactive shell ({shell}): {e}"))?;

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
