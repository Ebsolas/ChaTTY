# Chatty

Conversational terminal: Discord-style chat chrome over local (and later multi) shell sessions.

Yes, this is vibecoded. It's only a proof of concept to see if it's possible. 

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

## Download (Linux)

Prebuilt **AppImage** (x86_64) is attached to [GitHub Releases](https://github.com/Ebsolas/Chatty/releases):

```bash
chmod +x Chatty_*.AppImage
./Chatty_*.AppImage
```

The AppImage bundles **chatty-host** for durable sessions. Windows builds are planned next.

## Build

```bash
# Stages chatty-host sidecar, then builds AppImage (+ deb on supported hosts)
npm run tauri:build

# Dev without packaging:
npm run tauri dev

# After a release binary build:
./scripts/run-chatty.sh
```

AppImage output:

```text
src-tauri/target/release/bundle/appimage/Chatty_*.AppImage
```

If `linuxdeploy` fails on Arch (gtk plugin path quirks), `npm run tauri:build` falls back to packing the prepared AppDir with `appimagetool`. Set `APPIMAGE_EXTRACT_AND_RUN=1` if FUSE is unavailable.

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
| New (focused rail) | `Alt+N` |
| Close highlighted | `Alt+W` |
| Rename highlighted | `Alt+R` |
| Focus composer | `Alt+C` |
| Focus groups / conversations / sessions | `Alt+G` / `Alt+Shift+C` / `Alt+S` |
| Jump palette | `Alt+P` |
| Next / previous session | `Alt+]` / `Alt+[` |
| Cycle focus region | `Tab` / `Shift+Tab` (rails + composer only) |
| List up / down (in focused rail) | `↑` `↓` or `k` `j` |
| Activate selection | `Enter` |
| Back out layers | `Esc` |

**Rename** group, conversation, or session the same way: **right-click → Rename**, **pencil**, or **`Alt+R`** while the item is highlighted in the focused rail.

```bash
npm run tauri dev
```

Composer **↑ / ↓** recalls command history (persisted in localStorage). Each session has its own chat capture, so a TUI or long job on `@local` does not block `@local-2`.

### Groups & conversations

Hierarchy: **Group → Conversation → Sessions + chat**.

| Rail | Content |
|------|---------|
| Far left (thin) | **Groups** as monogram circles (initial + color) |
| Next | **Conversations** in the active group; header shows the **group name** |
| Right | **Sessions** for the active conversation |

| Action | Groups | Conversations |
|--------|--------|----------------|
| Switch | Click icon | Click row |
| New | `+` under icons (seeds conversation + session) | `+` in header (seeds a session) |
| Rename | Pencil / context menu / `Alt+R` on highlight | Pencil / context menu / `Alt+R` on highlight |
| Color | Context menu → Color… | — |
| Reorder | Drag / Move up·down | Drag / Move up·down |
| Delete | Context menu (kills nested sessions); last group reseeds **Home** | Context menu; last conversation reseeds **Main** |

Switching groups/conversations **unloads UI** only — PTYs keep running. Background finishes toast when you’re in another conversation.

### Persistence

On quit/restart Chatty restores **groups, conversations**, session **names, order, cwd, sticky target, and chat history** from:

```text
~/.config/chatty/state.json
```

**Session hosting (this machine only):**

Default engine is **`chatty-host`** (durable PTY process that outlives the UI — the cross-platform replacement for tmux’s role):

| Piece | Role |
|-------|------|
| `chatty-host` | Owns PTYs, ring buffer, process activity; listens on `$XDG_RUNTIME_DIR/chatty/host.sock` |
| Chatty UI | Attaches/detaches; quit does **not** kill host sessions |
| Close session in rail | Host **destroys** that PTY (confirm if busy/TUI) |

```bash
# Optional overrides
CHATTY_SESSION_ENGINE=host     # default on Unix
CHATTY_SESSION_ENGINE=legacy   # old in-process tmux/plain path
CHATTY_HOST_BIN=/path/to/chatty-host
```

Build the host next to the app: `cargo build --manifest-path src-tauri/Cargo.toml --bin chatty-host`.

Legacy fallback (`CHATTY_SESSION_ENGINE=legacy`): tmux when available, else plain PTY.

**Activity (busy / TUI)** comes from the host’s process-tree poll (same idea as tmux `pane_current_command`, without requiring tmux).

Closing a session that is **busy** or in a **TUI** is blocked with a warning until the job/UI exits (or you force-close later).

Deferred: branching UI, SSH, Windows/pwsh, force-close busy/TUI, job-runner exec channel.
