//! Shell flavor detection and argv construction for shell-agnostic exec.
//! Completion is always process exit — never shell hooks or timers.

use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ShellFlavor {
    Bash,
    Zsh,
    Fish,
    /// Fallback: try POSIX `sh -c`
    Sh,
}

impl ShellFlavor {
    pub fn detect(shell_path: &str) -> Self {
        let base = Path::new(shell_path)
            .file_name()
            .and_then(|s| s.to_str())
            .unwrap_or("")
            .to_ascii_lowercase();
        if base.contains("zsh") {
            ShellFlavor::Zsh
        } else if base.contains("bash") {
            ShellFlavor::Bash
        } else if base.contains("fish") {
            ShellFlavor::Fish
        } else {
            ShellFlavor::Sh
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            ShellFlavor::Bash => "bash",
            ShellFlavor::Zsh => "zsh",
            ShellFlavor::Fish => "fish",
            ShellFlavor::Sh => "sh",
        }
    }
}

/// Resolve login shell path.
pub fn resolve_shell() -> String {
    std::env::var("SHELL").unwrap_or_else(|_| {
        if Path::new("/bin/zsh").exists() {
            "/bin/zsh".into()
        } else if Path::new("/bin/bash").exists() {
            "/bin/bash".into()
        } else {
            "/bin/sh".into()
        }
    })
}

pub fn default_cwd() -> PathBuf {
    std::env::var_os("HOME")
        .map(PathBuf::from)
        .or_else(|| std::env::current_dir().ok())
        .unwrap_or_else(|| PathBuf::from("/"))
}

/// Build program + args to run `command` in a flavor-appropriate way.
/// The script prints user output, then a machine footer:
///   \x1eCT:CWD:<path>\x1e
///   \x1eCT:CODE:<n>\x1e
/// Footer is stripped by the frontend; process exit is the completion signal.
pub fn exec_invocation(
    shell_path: &str,
    flavor: ShellFlavor,
    command: &str,
) -> (String, Vec<String>) {
    // Pass command via env to avoid quoting landmines across shells.
    // Script reads CHATTY_CMD.
    let script = match flavor {
        ShellFlavor::Fish => {
            // fish: use eval on the env var
            r#"
set -l __ct_cmd $CHATTY_CMD
eval $__ct_cmd
set -l __ct_s $status
printf '\n\036CT:CWD:%s\036\n' (pwd)
printf '\036CT:CODE:%s\036\n' $__ct_s
exit $__ct_s
"#
            .trim()
            .to_string()
        }
        ShellFlavor::Bash | ShellFlavor::Zsh | ShellFlavor::Sh => r#"
eval "$CHATTY_CMD"
__ct_s=$?
printf '\n\036CT:CWD:%s\036\n' "$(pwd -P 2>/dev/null || pwd)"
printf '\036CT:CODE:%d\036\n' "$__ct_s"
exit $__ct_s
"#
        .trim()
        .to_string(),
    };

    let args = match flavor {
        ShellFlavor::Fish => vec!["-c".into(), script],
        // login-ish env without full interactive rc noise for chat turns
        ShellFlavor::Bash => vec!["-c".into(), script],
        ShellFlavor::Zsh => vec!["-c".into(), script],
        ShellFlavor::Sh => vec!["-c".into(), script],
    };

    let program = match flavor {
        ShellFlavor::Sh if !shell_path.ends_with("sh") => {
            // Prefer explicit sh for unknown shells when using sh scripts
            if Path::new("/bin/sh").exists() {
                "/bin/sh".into()
            } else {
                shell_path.to_string()
            }
        }
        _ => shell_path.to_string(),
    };

    // For bash/zsh, use the user's shell binary so aliases in non-interactive
    // mode are limited, but PATH/shell builtins match.
    let _ = command;
    (program, args)
}
