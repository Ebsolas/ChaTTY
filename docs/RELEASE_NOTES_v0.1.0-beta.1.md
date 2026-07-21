# Chatty v0.1.0-beta.1

First public pre-release of **Chatty** — a conversational terminal with Discord-style chat chrome over local interactive shell sessions.

## What's in this pre-release

### Sessions & host
- Multi-session shells (add / remove / rename / reorder)
- Shared chat + terminal view per session
- **chatty-host** durable PTY process (Unix socket protocol) with idle-drained output
- Fallback legacy engine via `CHATTY_SESSION_ENGINE=legacy` (tmux/plain)

### UI
- Groups monogram rail, conversations rail, sessions rail
- Resizable rails, named grid layout
- Absolute session-terminal overlay (no layout slide)
- Jump palette (`Alt+P`) and rail focus keyboard model

### Fixes included since earlier WIP
- Short command output (e.g. `whoami`) no longer stuck as `…`
- Session terminal fits after layout and caps open history replay

## Requirements
- Linux (developed on aarch64 Arch) with Node + Rust toolchain
- For host backend: `chatty-host` built alongside the app (`npm run tauri build` / `cargo build --bin chatty-host`)

## Install from source
```bash
git clone https://github.com/Ebsolas/Chatty.git
cd Chatty
git checkout v0.1.0-beta.1
npm install
npm run tauri dev
```

## Known limitations
- Pre-release: expect rough edges
- No signed multi-platform installers yet
- Windows host IPC (named pipes) not shipped
- Host process must restart with the UI after backend upgrades
