//! User shell launch profiles (`~/.config/chatty/profiles.json`).
//! Spawn templates only — not session history.

use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};

use crate::config;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptureHints {
    /// bash | zsh | fish | sh | powershell | unknown
    #[serde(default = "default_flavor")]
    pub flavor: String,
}

fn default_flavor() -> String {
    "unknown".into()
}

impl Default for CaptureHints {
    fn default() -> Self {
        Self {
            flavor: default_flavor(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShellProfile {
    pub id: String,
    pub label: String,
    pub shell: String,
    #[serde(default)]
    pub args: Vec<String>,
    /// null / omitted → use app default cwd
    #[serde(default)]
    pub cwd: Option<String>,
    #[serde(default)]
    pub env: std::collections::HashMap<String, String>,
    #[serde(default)]
    pub capture: CaptureHints,
    /// "shell" (default) | "ssh" — ssh prompts for destination at create time.
    #[serde(default = "default_kind")]
    pub kind: String,
}

fn default_kind() -> String {
    "shell".into()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProfilesFile {
    #[serde(default = "default_version")]
    pub version: u32,
    pub default_profile_id: String,
    pub profiles: Vec<ShellProfile>,
}

fn default_version() -> u32 {
    1
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProfilesPayload {
    pub default_profile_id: String,
    pub profiles: Vec<ShellProfile>,
    pub source_path: String,
}

#[derive(Debug, Clone)]
pub struct SpawnSpec {
    pub shell: String,
    pub args: Vec<String>,
    pub cwd: Option<String>,
    pub env: std::collections::HashMap<String, String>,
    pub capture_flavor: String,
    pub profile_id: String,
}

pub fn profiles_path() -> PathBuf {
    config::config_dir().join("profiles.json")
}

/// Common install locations (first existing executable wins per id).
fn detect_candidates() -> Vec<ShellProfile> {
    let mut out = Vec::new();

    let shells: &[(&str, &str, &[&str], &str)] = &[
        ("bash", "Bash", &["/bin/bash", "/usr/bin/bash"], "bash"),
        ("zsh", "Zsh", &["/bin/zsh", "/usr/bin/zsh"], "zsh"),
        ("fish", "Fish", &["/usr/bin/fish", "/bin/fish"], "fish"),
        ("sh", "sh", &["/bin/sh", "/usr/bin/sh"], "sh"),
        ("pwsh", "PowerShell", &["/usr/bin/pwsh", "/bin/pwsh"], "powershell"),
    ];

    for (id, label, paths, flavor) in shells {
        if let Some(shell) = paths.iter().map(Path::new).find(|p| p.is_file()) {
            let args = if *id == "sh" {
                vec!["-i".into()]
            } else if *id == "pwsh" {
                vec!["-NoLogo".into()]
            } else {
                vec!["-l".into(), "-i".into()]
            };
            out.push(ShellProfile {
                id: (*id).into(),
                label: (*label).into(),
                shell: shell.display().to_string(),
                args,
                cwd: None,
                env: Default::default(),
                capture: CaptureHints {
                    flavor: (*flavor).into(),
                },
                kind: "shell".into(),
            });
        }
    }

    // SSH profile: UI asks for destination at create time.
    if Path::new("/usr/bin/ssh").is_file() || Path::new("/bin/ssh").is_file() {
        let ssh = if Path::new("/usr/bin/ssh").is_file() {
            "/usr/bin/ssh"
        } else {
            "/bin/ssh"
        };
        out.push(ShellProfile {
            id: "ssh".into(),
            label: "SSH".into(),
            shell: ssh.into(),
            // Destination filled in when creating a session.
            args: vec!["-t".into()],
            cwd: None,
            env: Default::default(),
            capture: CaptureHints {
                flavor: "unknown".into(),
            },
            kind: "ssh".into(),
        });
    }

    out
}

fn default_profile_id_from_env(profiles: &[ShellProfile]) -> String {
    let shell_env = std::env::var("SHELL").unwrap_or_default();
    let base = Path::new(&shell_env)
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    if !base.is_empty() {
        if let Some(p) = profiles.iter().find(|p| p.id == base || p.shell.ends_with(&base)) {
            return p.id.clone();
        }
    }
    profiles
        .first()
        .map(|p| p.id.clone())
        .unwrap_or_else(|| "bash".into())
}

/// Load profiles; create file from auto-detect if missing.
/// If file exists, add any newly detected ids the user does not already have.
pub fn load_or_init_profiles() -> Result<ProfilesFile, String> {
    let dir = config::config_dir();
    fs::create_dir_all(&dir).map_err(|e| format!("create config dir: {e}"))?;
    let path = profiles_path();

    if !path.is_file() {
        let profiles = detect_candidates();
        if profiles.is_empty() {
            return Err("no shells found to build profiles".into());
        }
        let file = ProfilesFile {
            version: 1,
            default_profile_id: default_profile_id_from_env(&profiles),
            profiles,
        };
        save_profiles(&file)?;
        return Ok(file);
    }

    let text = fs::read_to_string(&path).map_err(|e| format!("read profiles: {e}"))?;
    let mut file: ProfilesFile =
        serde_json::from_str(&text).map_err(|e| format!("parse profiles: {e}"))?;
    if file.profiles.is_empty() {
        file.profiles = detect_candidates();
    }
    // Merge newly detected shells without clobbering user entries.
    let existing: std::collections::HashSet<String> =
        file.profiles.iter().map(|p| p.id.clone()).collect();
    for p in detect_candidates() {
        if !existing.contains(&p.id) {
            file.profiles.push(p);
        }
    }
    if !file.profiles.iter().any(|p| p.id == file.default_profile_id) {
        file.default_profile_id = default_profile_id_from_env(&file.profiles);
    }
    Ok(file)
}

pub fn save_profiles(file: &ProfilesFile) -> Result<(), String> {
    let path = profiles_path();
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("create config dir: {e}"))?;
    }
    let text = serde_json::to_string_pretty(file).map_err(|e| e.to_string())?;
    fs::write(&path, text + "\n").map_err(|e| format!("write profiles: {e}"))
}

pub fn profiles_payload() -> Result<ProfilesPayload, String> {
    let file = load_or_init_profiles()?;
    Ok(ProfilesPayload {
        default_profile_id: file.default_profile_id,
        profiles: file.profiles,
        source_path: profiles_path().display().to_string(),
    })
}

/// Whether this profile launches SSH (needs a destination at create time).
pub fn profile_is_ssh(p: &ShellProfile) -> bool {
    if p.kind.eq_ignore_ascii_case("ssh") {
        return true;
    }
    Path::new(&p.shell)
        .file_name()
        .and_then(|s| s.to_str())
        .map(|b| b.eq_ignore_ascii_case("ssh") || b.eq_ignore_ascii_case("ssh.exe"))
        .unwrap_or(false)
}

/// Insert/replace SSH destination in argv.
/// Typical result: `ssh -t user@host` (preserves other flags).
pub fn apply_ssh_target(args: &[String], target: &str) -> Result<Vec<String>, String> {
    let t = target.trim();
    if t.is_empty() {
        return Err("SSH destination required (e.g. user@host)".into());
    }
    if t.contains(char::is_whitespace) && !t.starts_with('[') {
        // Allow "user@host" or host only; reject multi-token mistakes.
        return Err("SSH destination should be host or user@host (no spaces)".into());
    }
    let mut out = args.to_vec();
    // Drop placeholder hosts from defaults.
    out.retain(|a| {
        let al = a.to_ascii_lowercase();
        al != "user@host" && al != "host" && al != "example.com"
    });
    // If last non-flag arg looks like a destination, replace it.
    if let Some(i) = out.iter().rposition(|a| !a.starts_with('-')) {
        out[i] = t.to_string();
    } else {
        // Ensure -t for remote TTY when not already present.
        if !out.iter().any(|a| a == "-t" || a == "-tt") {
            out.push("-t".into());
        }
        out.push(t.to_string());
    }
    Ok(out)
}

/// Resolve a profile id (or default) to a concrete spawn spec.
/// `ssh_target` is required when the profile is SSH.
pub fn resolve_spawn_spec(
    profile_id: Option<&str>,
    ssh_target: Option<&str>,
) -> Result<SpawnSpec, String> {
    let file = load_or_init_profiles()?;
    let id = profile_id
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or(file.default_profile_id.as_str());
    let p = file
        .profiles
        .iter()
        .find(|p| p.id == id)
        .or_else(|| file.profiles.first())
        .ok_or_else(|| "no profiles configured".to_string())?;

    let mut args = p.args.clone();
    if args.is_empty() && !profile_is_ssh(p) {
        let base = Path::new(&p.shell)
            .file_name()
            .and_then(|s| s.to_str())
            .unwrap_or("");
        if base.contains("bash") || base.contains("zsh") || base.contains("fish") {
            args = vec!["-l".into(), "-i".into()];
        }
    }

    if profile_is_ssh(p) {
        args = apply_ssh_target(&args, ssh_target.unwrap_or(""))?;
    }

    Ok(SpawnSpec {
        shell: p.shell.clone(),
        args,
        cwd: p.cwd.clone(),
        env: p.env.clone(),
        capture_flavor: p.capture.flavor.clone(),
        profile_id: p.id.clone(),
    })
}
