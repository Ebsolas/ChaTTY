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
| Rename | Click the **group name** in the conversations header | Double-click / context menu |
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

| Host has `tmux` | Behavior |
|-----------------|----------|
| **Yes** | Each session is `tmux new-session -A -s chatty-<id> …` with `~/.config/chatty/tmux.conf` (status bar off). Quit Chatty **detaches**; htop/builds stay alive. Reopen Chatty **reattaches**. Closing a session in the rail runs `tmux kill-session` (confirm if busy/TUI). |
| **No** | Plain login PTY (no reattach). Install tmux on the **Chatty host** for durable sessions. |

**SSH remotes never need tmux.** Future SSH sessions run `ssh` *inside* host-local tmux; only this machine needs the dependency.

**Activity (busy / TUI)** on tmux sessions comes from `pane_current_command` (poll), not stream heuristics — so status-bar redraws no longer lock sessions. Chat turns seal when the foreground process returns to the shell (with a quiet-timeout backup for very fast commands).

Host-local `~/.config/chatty/tmux.conf` turns the status bar off; Chatty also forces `status off` per `chatty-*` session so existing sessions lose the green bar without touching your other tmux sessions.

Closing a session that is **busy** or in a **TUI** is blocked with a warning until the job/UI exits (or you force-close later).

Deferred: branching UI, SSH, Windows/pwsh, force-close busy/TUI, job-runner exec channel.
