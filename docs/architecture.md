# ChaTTY architecture

PoC boundaries. Optimize for clarity and durable shells, not production multi-user.

## Layers

| Layer | Code | Owns | Does not own |
|-------|------|------|----------------|
| **L1 UI** | `src/lib/components/*`, routes | Rails, chat bubbles, composer, xterm **view**, keybindings | PTY, attach, ring buffer, host protocol |
| **L2 Facade** | `src/lib/sessionBridge.ts`, `stores`, `profiles` | Intents (`sendCommand`), turn capture/seal, chat format, app `state.json`, **shell profiles** | Spawning processes, host IPC details |
| **L3 Tauri** | `src-tauri/src/lib.rs`, `session.rs` | App session registry, ensure host, create/write/resize/destroy, **attach for UI process lifetime**, emit events | Bubble text, prompt stripping, groups UI |
| **L4 chatty-host** | `host_server`, `host_client`, `host_protocol` | PTYs, ring, output fan-out, activity, **attach/detach implementation** | Chat history, groups/conversations |

## Rules

1. **Attach ≠ open terminal.** Attach means the UI process is subscribed to host I/O for a session. The session terminal is only a view over scrollback + live events.
2. **Detach ≠ destroy.** App quit / disconnect detaches. Rail “close session” destroys the host PTY.
3. **One attach path** for the UI process: on create and on restore (if host already has the id, reattach — do not destroy).
4. **Profiles** are spawn templates (`~/.config/chatty/profiles.json`), not history. Chat + org tree stay in app state.
5. **Chat is a projection** of PTY bytes + turn policy (L2). The host only streams bytes.

## Data stores

| Store | Location | Contents |
|-------|----------|----------|
| Profiles | `~/.config/chatty/profiles.json` | Named shell/ssh launch specs |
| App state | `~/.config/chatty/state.json` | Groups, conversations, session ids/names, chat messages |
| Host live | memory (ring) | PTY output, attachers, activity |
| Host socket | `$XDG_RUNTIME_DIR/chatty/host.sock` | IPC |

## Session create (happy path)

```
L1 New session
 → L2 createSession(profileId?)
 → L3 create_session(name, id?, cwd?, profileId?)
 → resolve profile → shell + args + cwd
 → L4 session.create + session.attach
 → L3 emit session-created / session-output (replay)
 → L2 stores + scrollback
```

## UI restart (host still up)

```
L2 restore state.json session ids
 → L3 create_session(id=saved) 
 → if L4 already has id: attach only (no destroy)
 → else: create + attach
```
