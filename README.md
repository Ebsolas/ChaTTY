# Chatty

Conversational terminal: Discord-style chat chrome over local (and later multi) shell sessions.

**Repo:** [github.com/Ebsolas/Chatty](https://github.com/Ebsolas/Chatty)

## Stack

- **Tauri 2** (Rust) — desktop shell + PTY backend
- **SvelteKit** + Vite — UI
- Local interactive PTY sessions (chat + terminal views)

## Develop

```bash
npm install
npm run tauri dev
```

Frontend-only (no native shell):

```bash
npm run dev
```

## Build

```bash
npm run tauri build
# or: ./scripts/run-chatty.sh  (after build)
```

## Status

### MVP (done)

- Chat and session terminal share a single **login interactive PTY** per session.
- Composer injects lines; session typing creates chat turns (line mode; TUIs skipped).
- `@session` mentions + sticky target; busy/TUI detection; bubble click / **Ctrl+`** / **Alt+1–9**.

### MVP2 (in progress) — multi-session

- **Add** sessions (**+** or `Alt+N`); names auto-unique (`local`, `local-2`, …).
- **Remove** sessions (× or `Alt+W`); last session cannot be removed.
- **Rename** sessions (pencil icon, right-click menu, or `Alt+R`).
- **Open terminal** with `Alt+`` / `Alt+1`–`9` / click session.
- Cap: 16 concurrent shells. Chat history for closed sessions is kept.
- Target commands with `@local`, `@local-2`, or a custom name after rename.

### Keybindings

Defaults use **Alt** as the in-app navigation modifier. Customize:

```bash
# Created on first launch:
~/.config/chatty/keybindings.json

# Example in repo:
config/keybindings.example.json
```

| Action | Default |
|--------|---------|
| Toggle session terminal | `Alt+`` |
| Session 1–9 | `Alt+1` … `Alt+9` |
| New session | `Alt+N` |
| Close session | `Alt+W` |
| Rename session | `Alt+R` |
| Focus composer | `Alt+C` |
| Next / previous session | `Alt+]` / `Alt+[` |

```bash
npm run tauri dev
```

Deferred: branching UI, SSH, Windows/pwsh, concurrent multi-turn capture, job-runner exec channel.
