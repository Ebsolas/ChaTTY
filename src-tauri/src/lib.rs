mod session;
mod shell;

use session::{AppState, SessionInfo, DEFAULT_SESSION_NAME};

#[tauri::command]
fn greet(name: &str) -> String {
    format!("Hello, {name}! Chatty backend is up.")
}

#[tauri::command]
fn list_sessions(state: tauri::State<'_, AppState>) -> Result<Vec<SessionInfo>, String> {
    let mgr = state
        .sessions
        .lock()
        .map_err(|_| "session lock poisoned".to_string())?;
    Ok(mgr.list())
}

#[tauri::command]
fn create_session(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    name: Option<String>,
) -> Result<SessionInfo, String> {
    let mut mgr = state
        .sessions
        .lock()
        .map_err(|_| "session lock poisoned".to_string())?;
    mgr.create(app, name)
}

#[tauri::command]
fn ensure_local_session(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
) -> Result<SessionInfo, String> {
    let mut mgr = state
        .sessions
        .lock()
        .map_err(|_| "session lock poisoned".to_string())?;
    if let Some(id) = mgr.get_default_id() {
        if let Some(info) = mgr.list().into_iter().find(|s| s.id == id) {
            return Ok(info);
        }
    }
    mgr.create(app, Some(DEFAULT_SESSION_NAME.to_string()))
}

/// Shell-agnostic chat turn: process exit defines completion.
#[tauri::command]
fn run_command(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
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
    state: tauri::State<'_, AppState>,
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
    state: tauri::State<'_, AppState>,
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
    state: tauri::State<'_, AppState>,
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
            list_sessions,
            create_session,
            ensure_local_session,
            run_command,
            set_session_cwd,
            send_raw,
            resize_session,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
