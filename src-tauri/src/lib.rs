mod config;
mod session;
mod shell;

use config::{AppStateFile, KeybindingsPayload};
use session::{host_session_backend, AppState, SessionInfo, DEFAULT_SESSION_NAME};
use std::path::PathBuf;
use tauri::State;

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

/// Session hosting mode on this machine: "tmux" | "plain".
/// tmux is never required on SSH remotes — only on the Chatty host.
#[tauri::command]
fn session_host_backend() -> String {
    host_session_backend().as_str().to_string()
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
            // Host-local tmux activity poll (process-level busy/TUI/cwd).
            session::start_activity_poller(app.handle().clone());
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
