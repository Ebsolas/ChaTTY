//! User config loading (keybindings, etc.).

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;

/// Default in-app keybindings (Alt = navigation).
fn default_bindings() -> HashMap<String, String> {
    HashMap::from([
        ("toggleTerminal".into(), "Alt+Backquote".into()),
        ("newSession".into(), "Alt+N".into()),
        ("closeSession".into(), "Alt+W".into()),
        ("renameSession".into(), "Alt+R".into()),
        ("renameItem".into(), "Alt+R".into()),
        ("focusComposer".into(), "Alt+C".into()),
        ("focusGroups".into(), "Alt+G".into()),
        ("focusConversations".into(), "Alt+Shift+C".into()),
        ("focusSessions".into(), "Alt+S".into()),
        ("jumpPalette".into(), "Alt+P".into()),
        ("nextSession".into(), "Alt+BracketRight".into()),
        ("prevSession".into(), "Alt+BracketLeft".into()),
        ("session1".into(), "Alt+1".into()),
        ("session2".into(), "Alt+2".into()),
        ("session3".into(), "Alt+3".into()),
        ("session4".into(), "Alt+4".into()),
        ("session5".into(), "Alt+5".into()),
        ("session6".into(), "Alt+6".into()),
        ("session7".into(), "Alt+7".into()),
        ("session8".into(), "Alt+8".into()),
        ("session9".into(), "Alt+9".into()),
    ])
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KeybindingsFile {
    #[serde(default, rename = "$comment")]
    pub comment: Option<String>,
    #[serde(default)]
    pub bindings: HashMap<String, String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KeybindingsPayload {
    pub bindings: HashMap<String, String>,
    /// Path that was read, if any.
    pub source_path: Option<String>,
    /// Config directory for Chatty (created if missing when writing example).
    pub config_dir: String,
}

pub fn config_dir() -> PathBuf {
    if let Ok(xdg) = std::env::var("XDG_CONFIG_HOME") {
        if !xdg.is_empty() {
            return PathBuf::from(xdg).join("chatty");
        }
    }
    if let Ok(home) = std::env::var("HOME") {
        return PathBuf::from(home).join(".config").join("chatty");
    }
    PathBuf::from(".config").join("chatty")
}

pub fn keybindings_path() -> PathBuf {
    config_dir().join("keybindings.json")
}

pub fn tmux_conf_path() -> PathBuf {
    config_dir().join("tmux.conf")
}

/// Ensure a minimal Chatty-specific tmux config exists (status bar off, etc.).
/// Used only on the Chatty host — never required on SSH remotes.
pub fn ensure_tmux_conf() -> Result<PathBuf, String> {
    let dir = config_dir();
    fs::create_dir_all(&dir).map_err(|e| format!("create config dir: {e}"))?;
    let path = tmux_conf_path();
    // Always rewrite so upgrades pick up defaults (user can edit after; we only
    // create if missing to avoid clobbering customizations).
    if !path.is_file() {
        let conf = r#"# Chatty host-local tmux config (not used on SSH remotes).
# Outer PTY clients load this via `tmux -f …`.

set -g default-terminal "tmux-256color"
set -as terminal-features ",xterm-256color:RGB"
set -g status off
set -g set-titles off
set -g mouse on
set -g history-limit 50000
set -g escape-time 10
set -g focus-events on
"#;
        fs::write(&path, conf).map_err(|e| format!("write tmux.conf: {e}"))?;
    }
    Ok(path)
}

pub fn load_keybindings() -> KeybindingsPayload {
    let dir = config_dir();
    let path = keybindings_path();
    let mut bindings = default_bindings();
    let mut source_path = None;

    if path.is_file() {
        match fs::read_to_string(&path) {
            Ok(text) => match serde_json::from_str::<KeybindingsFile>(&text) {
                Ok(file) => {
                    for (k, v) in file.bindings {
                        if !v.trim().is_empty() {
                            bindings.insert(k, v);
                        }
                    }
                    source_path = Some(path.display().to_string());
                }
                Err(e) => {
                    eprintln!("chatty: invalid keybindings.json: {e}");
                }
            },
            Err(e) => {
                eprintln!("chatty: could not read keybindings.json: {e}");
            }
        }
    }

    KeybindingsPayload {
        bindings,
        source_path,
        config_dir: dir.display().to_string(),
    }
}

/// Ensure config dir exists and write an example file if no keybindings.json yet.
pub fn ensure_keybindings_example() -> Result<String, String> {
    let dir = config_dir();
    fs::create_dir_all(&dir).map_err(|e| format!("create config dir: {e}"))?;
    let path = keybindings_path();
    if path.exists() {
        return Ok(path.display().to_string());
    }
    let example = serde_json::json!({
        "$comment": "Chatty keybindings. Alt is the default navigation modifier. Delete keys to fall back to built-in defaults after restart.",
        "bindings": default_bindings(),
    });
    let text = serde_json::to_string_pretty(&example)
        .map_err(|e| format!("serialize example: {e}"))?;
    fs::write(&path, text + "\n").map_err(|e| format!("write keybindings: {e}"))?;
    Ok(path.display().to_string())
}

// ─── App state persistence (sessions + chat history) ─────────────────────────

pub fn state_path() -> PathBuf {
    config_dir().join("state.json")
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedSession {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub cwd: String,
    #[serde(default)]
    pub shell: String,
    /// Conversation membership (frontend-owned; optional for v1 state files).
    #[serde(default)]
    pub conversation_id: Option<String>,
}

/// Opaque blobs (frontend-owned shapes).
pub type SavedMessage = serde_json::Value;
pub type SavedConversation = serde_json::Value;
pub type SavedConversationFocus = serde_json::Value;
pub type SavedGroup = serde_json::Value;
pub type SavedGroupFocus = serde_json::Value;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppStateFile {
    #[serde(default = "default_state_version")]
    pub version: u32,
    #[serde(default)]
    pub saved_at: u64,
    #[serde(default)]
    pub sticky_session_id: Option<String>,
    #[serde(default)]
    pub active_session_id: Option<String>,
    #[serde(default)]
    pub expanded_session_id: Option<String>,
    #[serde(default)]
    pub active_conversation_id: Option<String>,
    #[serde(default)]
    pub active_group_id: Option<String>,
    #[serde(default)]
    pub groups: Vec<SavedGroup>,
    #[serde(default)]
    pub group_focus: Option<SavedGroupFocus>,
    #[serde(default)]
    pub conversations: Vec<SavedConversation>,
    #[serde(default)]
    pub conversation_focus: Option<SavedConversationFocus>,
    #[serde(default)]
    pub sessions: Vec<SavedSession>,
    #[serde(default)]
    pub messages: Vec<SavedMessage>,
}

fn default_state_version() -> u32 {
    3
}

impl Default for AppStateFile {
    fn default() -> Self {
        Self {
            version: 3,
            saved_at: 0,
            sticky_session_id: None,
            active_session_id: None,
            expanded_session_id: None,
            active_conversation_id: None,
            active_group_id: None,
            groups: Vec::new(),
            group_focus: None,
            conversations: Vec::new(),
            conversation_focus: None,
            sessions: Vec::new(),
            messages: Vec::new(),
        }
    }
}

pub fn load_app_state() -> AppStateFile {
    let path = state_path();
    if !path.is_file() {
        return AppStateFile::default();
    }
    match fs::read_to_string(&path) {
        Ok(text) => match serde_json::from_str::<AppStateFile>(&text) {
            Ok(mut state) => {
                // Soft cap on load so a huge file can't melt the UI.
                const MAX_MESSAGES: usize = 500;
                if state.messages.len() > MAX_MESSAGES {
                    state.messages = state
                        .messages
                        .split_off(state.messages.len() - MAX_MESSAGES);
                }
                state
            }
            Err(e) => {
                eprintln!("chatty: invalid state.json: {e}");
                AppStateFile::default()
            }
        },
        Err(e) => {
            eprintln!("chatty: could not read state.json: {e}");
            AppStateFile::default()
        }
    }
}

pub fn save_app_state(mut state: AppStateFile) -> Result<String, String> {
    let dir = config_dir();
    fs::create_dir_all(&dir).map_err(|e| format!("create config dir: {e}"))?;

    const MAX_MESSAGES: usize = 500;
    if state.messages.len() > MAX_MESSAGES {
        state.messages = state
            .messages
            .split_off(state.messages.len() - MAX_MESSAGES);
    }
    // Frontend owns schema evolution; accept whatever version it sends.
    if state.version < 3 {
        state.version = 3;
    }
    state.saved_at = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);

    let path = state_path();
    let text = serde_json::to_string_pretty(&state)
        .map_err(|e| format!("serialize state: {e}"))?;
    // Atomic-ish write: temp then rename.
    let tmp = path.with_extension("json.tmp");
    fs::write(&tmp, text + "\n").map_err(|e| format!("write state: {e}"))?;
    fs::rename(&tmp, &path).map_err(|e| format!("rename state: {e}"))?;
    Ok(path.display().to_string())
}
