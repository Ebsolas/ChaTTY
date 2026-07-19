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
        ("focusComposer".into(), "Alt+C".into()),
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
