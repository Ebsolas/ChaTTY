# ChatTerm

Conversational terminal: Discord-style chat chrome over local (and later multi) shell sessions.

> Possibly rename to Chatty later.

## Stack

- **Tauri 2** (Rust) — desktop shell + PTY backend
- **SvelteKit** + Vite — UI
- Local PTY sessions (MVP: one session, chat bubbles; TUI/xterm deferred)

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

```bash
npm run tauri dev
# or: ./src-tauri/target/release/chatterm
```

Deferred: branching UI, SSH, Windows/pwsh, job-runner exec channel.
