# Chatty

Conversational terminal: Discord-style chat chrome over local (and later multi) shell sessions.

**Repo:** [github.com/Ebsolas/Chatty](https://github.com/Ebsolas/Chatty)

## Stack

- **Tauri 2** (Rust) — desktop shell + PTY backend
- **SvelteKit** + Vite — UI
- Local PTY sessions (MVP: one interactive shell, chat + terminal views)

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
```

## Status

**MVP (one interactive shell, two views):**

- Chat and session terminal share a single **login interactive PTY** (aliases, profile, cwd).
- Composer injects lines into that PTY; session typing creates chat turns (line mode; TUIs skipped).
- `@session` mentions + sticky target supported.
- Busy/TUI detection: UI stays usable; chat inject is blocked while a TUI is active.
- Open session via bubble click or **Ctrl+`** / **Alt+1**.

```bash
npm run tauri dev
# or: ./scripts/run-chatty.sh
```

Deferred: branching UI, SSH, Windows/pwsh, job-runner exec channel.
