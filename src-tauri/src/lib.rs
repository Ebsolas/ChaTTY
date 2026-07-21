pub mod config;
pub mod host_client;
pub mod host_protocol;
pub mod host_server;
pub mod session;
pub mod shell;

use config::{AppStateFile, KeybindingsPayload};
use host_client::{resolve_host_binary, session_engine, HostClient, SessionEngine};
use session::{
    host_session_backend, AppState, SessionBackend, SessionInfo, DEFAULT_SESSION_NAME,
};
use std::path::PathBuf;
use tauri::{Emitter, Manager, State};

#[tauri::command]
fn greet(name: &str) -> String {
    format!("Hello, {name}! Chatty backend is up.")
}

/// Load keybindings: defaults merged with ~/.config/chatty/keybindings.json
#[tauri::command]
fn get_keybindings() -> KeybindingsPayload {
    config::load_keybindings()
}

/// Create ~/.config/chatty/keybindings.json from defaults if missing.
#[tauri::command]
fn ensure_keybindings_config() -> Result<String, String> {
    config::ensure_keybindings_example()
}

#[tauri::command]
fn load_app_state() -> AppStateFile {
    config::load_app_state()
}

/// Session hosting mode on this machine: "host" | "tmux" | "plain".
/// `host` = chatty-host durable PTYs (preferred). `tmux`/`plain` = legacy.
#[tauri::command]
fn session_host_backend() -> String {
    host_session_backend().as_str().to_string()
}

fn ensure_host(state: &AppState, app: &tauri::AppHandle) -> Result<(), String> {
    let mut slot = state
        .host
        .lock()
        .map_err(|_| "host lock poisoned".to_string())?;
    if slot.is_some() {
        return Ok(());
    }
    let bin = resolve_host_binary();
    let client = HostClient::ensure_connected(&bin)?;
    client.set_app_emitter(app.clone());
    *slot = Some(client);
    Ok(())
}

#[tauri::command]
fn save_app_state(state: AppStateFile) -> Result<String, String> {
    config::save_app_state(state)
}

#[tauri::command]
fn list_sessions(state: State<'_, AppState>) -> Result<Vec<SessionInfo>, String> {
    let mgr = state
        .sessions
        .lock()
        .map_err(|_| "session lock poisoned".to_string())?;
    Ok(mgr.list())
}

/// Create a session without holding the manager lock during fork/exec.
///
/// Optional `id` / `cwd` are used when restoring saved sessions.
#[tauri::command]
async fn create_session(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    name: Option<String>,
    id: Option<String>,
    cwd: Option<String>,
) -> Result<SessionInfo, String> {
    create_session_async(app, state, name, id, cwd).await
}

async fn create_session_async(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    name: Option<String>,
    id: Option<String>,
    cwd: Option<String>,
) -> Result<SessionInfo, String> {
    let reserved = {
        let mut mgr = state
            .sessions
            .lock()
            .map_err(|_| "session lock poisoned".to_string())?;
        mgr.begin_create(&app, name, id, cwd)?
    };

    let sid = reserved.id.clone();
    let shell = reserved.shell.clone();
    let cwd_path = PathBuf::from(&reserved.cwd);
    let app_spawn = app.clone();
    let id_spawn = sid.clone();

    // Durable host path (default on Unix): PTY lives in chatty-host.
    if reserved.backend == "host" || host_session_backend() == SessionBackend::Host {
        if let Err(e) = ensure_host(&state, &app) {
            let mut mgr = state
                .sessions
                .lock()
                .map_err(|_| "session lock poisoned".to_string())?;
            mgr.abort_create(&app, &sid);
            return Err(e);
        }
        let create_result = {
            let host = state
                .host
                .lock()
                .map_err(|_| "host lock poisoned".to_string())?;
            let host = host
                .as_ref()
                .ok_or_else(|| "host client missing".to_string())?;
            host.create(
                &sid,
                &shell,
                &cwd_path.to_string_lossy(),
                120,
                40,
            )
            .and_then(|_| host.attach(&sid))
        };
        match create_result {
            Ok(replay) => {
                if !replay.is_empty() {
                    let _ = app.emit(
                        "session-output",
                        session::SessionOutputEvent {
                            session_id: sid.clone(),
                            chunk: replay,
                        },
                    );
                }
                let mut mgr = state
                    .sessions
                    .lock()
                    .map_err(|_| "session lock poisoned".to_string())?;
                return mgr.finish_create_host(&sid);
            }
            Err(e) => {
                let mut mgr = state
                    .sessions
                    .lock()
                    .map_err(|_| "session lock poisoned".to_string())?;
                mgr.abort_create(&app, &sid);
                return Err(e);
            }
        }
    }

    let spawn_result = tauri::async_runtime::spawn_blocking(move || {
        session::spawn_interactive_pty_public(&app_spawn, &id_spawn, &shell, &cwd_path)
    })
    .await
    .map_err(|e| format!("spawn task failed: {e}"))?;

    match spawn_result {
        Ok(pty) => {
            let mut mgr = state
                .sessions
                .lock()
                .map_err(|_| "session lock poisoned".to_string())?;
            mgr.finish_create(&sid, pty)
        }
        Err(e) => {
            let mut mgr = state
                .sessions
                .lock()
                .map_err(|_| "session lock poisoned".to_string())?;
            mgr.abort_create(&app, &sid);
            Err(e)
        }
    }
}

#[tauri::command]
async fn ensure_local_session(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
) -> Result<SessionInfo, String> {
    {
        let mgr = state
            .sessions
            .lock()
            .map_err(|_| "session lock poisoned".to_string())?;
        if let Some(id) = mgr.get_default_id() {
            if let Some(info) = mgr.list().into_iter().find(|s| s.id == id) {
                return Ok(info);
            }
        }
    }
    create_session_async(
        app,
        state,
        Some(DEFAULT_SESSION_NAME.to_string()),
        None,
        None,
    )
    .await
}

#[tauri::command]
fn close_session(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    session_id: String,
) -> Result<(), String> {
    let backend = {
        let mgr = state
            .sessions
            .lock()
            .map_err(|_| "session lock poisoned".to_string())?;
        mgr.backend_of(&session_id).ok()
    };
    if backend == Some(SessionBackend::Host) {
        if let Ok(host) = state.host.lock() {
            if let Some(h) = host.as_ref() {
                let _ = h.destroy(&session_id);
            }
        }
    }
    let mut mgr = state
        .sessions
        .lock()
        .map_err(|_| "session lock poisoned".to_string())?;
    mgr.close(&app, &session_id)
}

#[tauri::command]
fn rename_session(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    session_id: String,
    name: String,
) -> Result<SessionInfo, String> {
    let mut mgr = state
        .sessions
        .lock()
        .map_err(|_| "session lock poisoned".to_string())?;
    mgr.rename(&app, &session_id, &name)
}

/// Shell-agnostic chat turn: process exit defines completion.
#[tauri::command]
fn run_command(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    session_id: String,
    command: String,
) -> Result<String, String> {
    let mgr = state
        .sessions
        .lock()
        .map_err(|_| "session lock poisoned".to_string())?;
    mgr.run_command(app, &session_id, &command)
}

#[tauri::command]
fn set_session_cwd(
    state: State<'_, AppState>,
    session_id: String,
    cwd: String,
) -> Result<(), String> {
    let mut mgr = state
        .sessions
        .lock()
        .map_err(|_| "session lock poisoned".to_string())?;
    mgr.set_cwd(&session_id, &cwd)
}

#[tauri::command]
fn send_raw(
    state: State<'_, AppState>,
    session_id: String,
    bytes: Vec<u8>,
) -> Result<(), String> {
    let backend = {
        let mgr = state
            .sessions
            .lock()
            .map_err(|_| "session lock poisoned".to_string())?;
        mgr.backend_of(&session_id)?
    };
    if backend == SessionBackend::Host {
        let host = state
            .host
            .lock()
            .map_err(|_| "host lock poisoned".to_string())?;
        let host = host
            .as_ref()
            .ok_or_else(|| "host client not connected".to_string())?;
        return host.write_bytes(&session_id, &bytes);
    }
    let mgr = state
        .sessions
        .lock()
        .map_err(|_| "session lock poisoned".to_string())?;
    mgr.send_raw(&session_id, &bytes)
}

#[tauri::command]
fn resize_session(
    state: State<'_, AppState>,
    session_id: String,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    let backend = {
        let mgr = state
            .sessions
            .lock()
            .map_err(|_| "session lock poisoned".to_string())?;
        mgr.backend_of(&session_id)?
    };
    if backend == SessionBackend::Host {
        let host = state
            .host
            .lock()
            .map_err(|_| "host lock poisoned".to_string())?;
        let host = host
            .as_ref()
            .ok_or_else(|| "host client not connected".to_string())?;
        return host.resize(&session_id, cols, rows);
    }
    let mgr = state
        .sessions
        .lock()
        .map_err(|_| "session lock poisoned".to_string())?;
    mgr.resize(&session_id, cols, rows)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(AppState::new())
        .setup(|app| {
            // Prefer chatty-host (durable PTYs). Legacy tmux poller still runs when needed.
            if session_engine() == SessionEngine::Host {
                if let Some(state) = app.try_state::<AppState>() {
                    if let Err(e) = ensure_host(state.inner(), app.handle()) {
                        eprintln!("chatty: could not start chatty-host: {e}");
                        eprintln!("chatty: set CHATTY_SESSION_ENGINE=legacy to use tmux/plain");
                    }
                }
            } else {
                // Legacy: process truth from host-local tmux.
                session::start_activity_poller(app.handle().clone());
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            greet,
            get_keybindings,
            ensure_keybindings_config,
            load_app_state,
            save_app_state,
            session_host_backend,
            list_sessions,
            create_session,
            ensure_local_session,
            close_session,
            rename_session,
            run_command,
            set_session_cwd,
            send_raw,
            resize_session,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
