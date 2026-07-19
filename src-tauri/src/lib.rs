mod config;
mod session;
mod shell;

use config::KeybindingsPayload;
use session::{AppState, SessionInfo, DEFAULT_SESSION_NAME};
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
fn list_sessions(state: State<'_, AppState>) -> Result<Vec<SessionInfo>, String> {
    let mgr = state
        .sessions
        .lock()
        .map_err(|_| "session lock poisoned".to_string())?;
    Ok(mgr.list())
}

/// Create a session without holding the manager lock during fork/exec.
///
/// 1. Reserve name/id under a short lock and emit `session-created` (UI paints).
/// 2. Spawn the login PTY on a blocking pool thread.
/// 3. Attach the PTY and return.
#[tauri::command]
async fn create_session(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    name: Option<String>,
) -> Result<SessionInfo, String> {
    create_session_async(app, state, name).await
}

async fn create_session_async(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    name: Option<String>,
) -> Result<SessionInfo, String> {
    let reserved = {
        let mut mgr = state
            .sessions
            .lock()
            .map_err(|_| "session lock poisoned".to_string())?;
        mgr.begin_create(&app, name)?
    };

    let id = reserved.id.clone();
    let shell = reserved.shell.clone();
    let cwd = PathBuf::from(&reserved.cwd);
    let app_spawn = app.clone();
    let id_spawn = id.clone();

    let spawn_result = tauri::async_runtime::spawn_blocking(move || {
        session::spawn_interactive_pty_public(&app_spawn, &id_spawn, &shell, &cwd)
    })
    .await
    .map_err(|e| format!("spawn task failed: {e}"))?;

    match spawn_result {
        Ok(pty) => {
            let mut mgr = state
                .sessions
                .lock()
                .map_err(|_| "session lock poisoned".to_string())?;
            mgr.finish_create(&id, pty)
        }
        Err(e) => {
            let mut mgr = state
                .sessions
                .lock()
                .map_err(|_| "session lock poisoned".to_string())?;
            mgr.abort_create(&app, &id);
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
    create_session_async(app, state, Some(DEFAULT_SESSION_NAME.to_string())).await
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
        .invoke_handler(tauri::generate_handler![
            greet,
            get_keybindings,
            ensure_keybindings_config,
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
