/**
 * Unified session hub: one interactive PTY per session.
 * Chat and session terminal are two views of the same shell.
 */

import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { get } from "svelte/store";
import { parseComposer, parseLeadingMentions } from "./mentions";
import {
  flushSaveAppState,
  loadAppState,
  normalizeLoadedMessages,
  pausePersistence,
  resumePersistence,
  scheduleSaveAppState,
} from "./persistence";
import { resetAltScreenCarry, scanAltScreen } from "./termDetect";
import {
  activeSessionId,
  activeTurns,
  altScreenSessions,
  appendUserMessage,
  applySessionActivityPoll,
  applySessionRename,
  backendError,
  backendToSession,
  connected,
  expandedSessionId,
  formatPtyCapture,
  getSessionTurn,
  markSessionReady,
  messages,
  MIN_AFTER_FIRST_CHUNK_MS,
  openSessionBubble,
  patchSessionTurn,
  pushToast,
  QUIET_MS,
  removeSession,
  sealTurn,
  sessions,
  setSessionActivity,
  setSessionProcessStatus,
  setSessionTurn,
  setSessionTui,
  stickySessionId,
  TURN_MAX_MS,
  updateTurnBubble,
  upsertSession,
  type TurnSource,
} from "./stores";
import type {
  BackendSessionInfo,
  SessionActivityEvent,
  SessionExitEvent,
  SessionInfo,
  SessionOutputEvent,
  SessionRemovedEvent,
  SessionStatusEvent,
} from "./types";

const unlistens: UnlistenFn[] = [];
const storeUnsubs: Array<() => void> = [];
const ptyScrollback = new Map<string, string>();
const SCROLLBACK_MAX = 500_000;

/** Per-session quiet / max seal timers (independent captures). */
const quietTimers = new Map<string, ReturnType<typeof setTimeout>>();
const maxTimers = new Map<string, ReturnType<typeof setTimeout>>();
/** Tmux: session ids whose turn has observed a non-shell pane process. */
const turnSawProcess = new Set<string>();

type RawListener = (sessionId: string, chunk: string) => void;
const rawListeners = new Set<RawListener>();

/** Coalesce xterm/raw writes to one rAF tick so login-shell floods don't jank. */
const rawPending = new Map<string, string>();
let rawFlushScheduled = false;

/** Keys typed in the session terminal since the last Enter (for chat mirroring). */
const termLineBuf = new Map<string, string>();

export function subscribeRawOutput(fn: RawListener): () => void {
  rawListeners.add(fn);
  return () => rawListeners.delete(fn);
}

function notifyRawListeners(sessionId: string, text: string) {
  if (!text || rawListeners.size === 0) return;
  rawPending.set(sessionId, (rawPending.get(sessionId) ?? "") + text);
  if (rawFlushScheduled) return;
  rawFlushScheduled = true;
  const schedule =
    typeof requestAnimationFrame === "function"
      ? requestAnimationFrame
      : (cb: FrameRequestCallback) => setTimeout(() => cb(performance.now()), 16);
  schedule(() => {
    rawFlushScheduled = false;
    if (rawPending.size === 0) return;
    const batch = new Map(rawPending);
    rawPending.clear();
    for (const [id, chunk] of batch) {
      for (const fn of rawListeners) {
        try {
          fn(id, chunk);
        } catch {
          /* ignore */
        }
      }
    }
  });
}

export function getPtyScrollback(sessionId: string): string {
  return ptyScrollback.get(sessionId) ?? "";
}

export function getSessionScrollback(sessionId: string): string {
  return getPtyScrollback(sessionId);
}

export function getChatScrollback(sessionId: string): string {
  return getPtyScrollback(sessionId);
}

function appendPty(sessionId: string, text: string) {
  if (!text) return;
  const prev = ptyScrollback.get(sessionId) ?? "";
  let next = prev + text;
  if (next.length > SCROLLBACK_MAX) next = next.slice(next.length - SCROLLBACK_MAX);
  ptyScrollback.set(sessionId, next);

  // CSI alt-screen only for plain (non-tmux) backends. Tmux sessions use
  // pane_current_command polling as the source of truth for busy/TUI.
  const sess = get(sessions).find((s) => s.id === sessionId);
  const tmuxBacked = sess?.backend === "tmux";
  if (!tmuxBacked) {
    const alt = scanAltScreen(sessionId, text);
    if (alt === "enter") {
      enterTuiMode(sessionId);
    } else if (alt === "leave") {
      leaveTuiMode(sessionId);
    }
  }

  notifyRawListeners(sessionId, text);

  const turn = getSessionTurn(sessionId);
  if (!turn) return;
  // Don't accumulate TUI framebuffer noise into the chat capture.
  const inTui =
    turn.pausedForTui ||
    get(altScreenSessions).has(sessionId) ||
    sess?.activity === "tui" ||
    !!sess?.tuiActive;
  if (inTui) return;

  const now = Date.now();
  const raw = turn.raw + text;
  patchSessionTurn(sessionId, {
    raw,
    sawChunk: true,
    firstChunkAt: turn.firstChunkAt ?? now,
    lastChunkAt: now,
  });
  updateTurnBubble(turn.messageId, formatPtyCapture(raw, turn.command) || "…", {
    open: true,
    turnStatus: "running",
  });
  scheduleQuietSeal(sessionId);
}

/** Mark session as TUI; cancel seal timers so long-lived apps never "time out". */
function enterTuiMode(sessionId: string) {
  const already = get(altScreenSessions).has(sessionId);
  setSessionTui(sessionId, true);
  termLineBuf.set(sessionId, "");
  clearTimers(sessionId);
  const turn = getSessionTurn(sessionId);
  if (turn && !turn.pausedForTui) {
    patchSessionTurn(sessionId, { pausedForTui: true });
    updateTurnBubble(turn.messageId, "[interactive UI running — open session view]", {
      open: true,
      turnStatus: "tui",
    });
  } else if (!already && turn?.pausedForTui) {
    // already marked
  }
}

/** Only path that clears TUI — requires explicit alt-screen leave CSI. */
function leaveTuiMode(sessionId: string) {
  if (!get(altScreenSessions).has(sessionId)) return;
  setSessionTui(sessionId, false);
  const turn = getSessionTurn(sessionId);
  if (turn?.pausedForTui) {
    sealTurn(sessionId, "tui");
    clearTimers(sessionId);
  }
}

function clearTimers(sessionId: string) {
  const q = quietTimers.get(sessionId);
  if (q) {
    clearTimeout(q);
    quietTimers.delete(sessionId);
  }
  const m = maxTimers.get(sessionId);
  if (m) {
    clearTimeout(m);
    maxTimers.delete(sessionId);
  }
}

function clearAllTimers() {
  for (const id of [...quietTimers.keys()]) clearTimers(id);
}

function scheduleQuietSeal(sessionId: string) {
  const prev = quietTimers.get(sessionId);
  if (prev) clearTimeout(prev);
  // Never quiet-seal while a full-screen TUI owns this session.
  if (get(altScreenSessions).has(sessionId)) return;
  const sess = get(sessions).find((s) => s.id === sessionId);
  if (sess?.activity === "tui") return;

  // Tmux: quiet seal is backup — process poll is primary. Slightly longer delay
  // so we don't seal mid-command when poll briefly lags.
  const isTmux = sess?.backend === "tmux";
  const delay = isTmux ? Math.max(QUIET_MS, 800) : QUIET_MS;

  quietTimers.set(
    sessionId,
    setTimeout(() => {
      const turn = getSessionTurn(sessionId);
      if (!turn) return;

      const live = get(sessions).find((s) => s.id === sessionId);
      if (
        turn.pausedForTui ||
        get(altScreenSessions).has(sessionId) ||
        live?.activity === "tui"
      ) {
        return;
      }

      // Tmux + poll says idle (or never left idle after grace) → seal.
      // Avoids stuck "busy" when PTY keep-alives keep resetting quiet timers.
      if (isTmux || live?.backend === "tmux") {
        const age = Date.now() - turn.startedAt;
        if (live?.activity === "idle" && age >= 700) {
          sealTurn(sessionId, "ok");
          clearTimers(sessionId);
          turnSawProcess.delete(sessionId);
          return;
        }
        if (live?.activity === "busy" && age >= 900 && !turnSawProcess.has(sessionId)) {
          // Optimistic busy but poll never confirmed a process → clear.
          sealTurn(sessionId, "ok");
          clearTimers(sessionId);
          turnSawProcess.delete(sessionId);
          return;
        }
      }

      // Wait until we've actually received PTY data for this turn.
      if (!turn.sawChunk || turn.firstChunkAt == null) {
        // Fast no-output commands: seal after a bit anyway on tmux.
        if (live?.backend === "tmux" && Date.now() - turn.startedAt > 1200) {
          sealTurn(sessionId, "ok");
          clearTimers(sessionId);
          turnSawProcess.delete(sessionId);
          return;
        }
        scheduleQuietSeal(sessionId);
        return;
      }
      const sinceFirst = Date.now() - turn.firstChunkAt;
      if (sinceFirst < MIN_AFTER_FIRST_CHUNK_MS) {
        scheduleQuietSeal(sessionId);
        return;
      }

      // Don't seal empty if data might still be coming (Starship/slow cmds).
      const body = formatPtyCapture(turn.raw, turn.command);
      const sinceLast = Date.now() - turn.lastChunkAt;
      if (!body && sinceLast < 1500) {
        scheduleQuietSeal(sessionId);
        return;
      }

      // Cap how long continuous PTY noise can postpone a seal on tmux.
      if (live?.backend === "tmux" && Date.now() - turn.startedAt > 2500 && live.activity === "idle") {
        sealTurn(sessionId, "ok");
        clearTimers(sessionId);
        turnSawProcess.delete(sessionId);
        return;
      }

      sealTurn(sessionId, "ok");
      clearTimers(sessionId);
      turnSawProcess.delete(sessionId);
    }, delay),
  );
}

function armMaxTimer(sessionId: string, turnId: string) {
  const prev = maxTimers.get(sessionId);
  if (prev) clearTimeout(prev);
  const sess = get(sessions).find((s) => s.id === sessionId);
  // Tmux: process poll seals turns; keep a long safety max only.
  // TUIs can run indefinitely — no hard deadline while marked tui.
  if (get(altScreenSessions).has(sessionId) || sess?.activity === "tui") return;

  const maxMs = sess?.backend === "tmux" ? TURN_MAX_MS : TURN_MAX_MS;
  maxTimers.set(
    sessionId,
    setTimeout(() => {
      const t = getSessionTurn(sessionId);
      if (!t || t.turnId !== turnId) return;
      if (
        t.pausedForTui ||
        get(altScreenSessions).has(sessionId) ||
        get(sessions).find((s) => s.id === sessionId)?.activity === "tui"
      ) {
        clearTimers(sessionId);
        return;
      }
      sealTurn(sessionId, "ok");
      clearTimers(sessionId);
    }, maxMs),
  );
}

/**
 * Arm capture for one session. Other sessions keep their open turns
 * (ranger on @local does not seal a build on @local-2).
 */
function startTurnCapture(
  session: SessionInfo,
  command: string,
  display: string,
  source: TurnSource,
): string {
  // Only seal an existing turn on *this* session.
  if (getSessionTurn(session.id)) {
    sealTurn(session.id, "ok");
    clearTimers(session.id);
  }
  turnSawProcess.delete(session.id);

  const turnId = crypto.randomUUID();
  appendUserMessage(display, session.id, session.name, turnId);
  const bubble = openSessionBubble(session.id, session.name, turnId);
  setSessionTurn(session.id, {
    turnId,
    sessionId: session.id,
    command,
    messageId: bubble.id,
    source,
    startedAt: Date.now(),
    firstChunkAt: null,
    lastChunkAt: Date.now(),
    raw: "",
    sawChunk: false,
    pausedForTui: false,
  });
  // If already in TUI, mark busy-as-tui and never arm seal timers.
  if (get(altScreenSessions).has(session.id)) {
    setSessionActivity(session.id, "tui", command);
    patchSessionTurn(session.id, { pausedForTui: true });
    activeSessionId.set(session.id);
    stickySessionId.set(session.id);
    clearTimers(session.id);
    return turnId;
  }

  setSessionActivity(session.id, "busy", command);
  activeSessionId.set(session.id);
  stickySessionId.set(session.id);
  armMaxTimer(session.id, turnId);
  scheduleQuietSeal(session.id);
  return turnId;
}

export async function initSessionBridge(): Promise<void> {
  // Pause autosave while we tear down / rebuild so we never write empty sessions.
  pausePersistence();
  await teardownSessionBridge({ persist: false });
  backendError.set(null);
  ptyScrollback.clear();
  termLineBuf.clear();
  messages.set([]);
  sessions.set([]);
  expandedSessionId.set(null);
  altScreenSessions.set(new Set());

  try {
    // Listeners first so we never miss spawn output during restore.
    await attachSessionListeners();

    const saved = await loadAppState();
    if (saved?.sessions?.length) {
      const failures: string[] = [];
      // Sequential spawn keeps login shells from thrashing the machine,
      // but always finish the full list (don't abort on one failure).
      for (const s of saved.sessions) {
        try {
          const info = await invoke<BackendSessionInfo>("create_session", {
            name: s.name ?? null,
            id: s.id ?? null,
            cwd: s.cwd ? s.cwd : null,
          });
          const session = backendToSession(info, { starting: false });
          upsertSession(session);
          markSessionReady(session.id);
        } catch (err) {
          console.error("restore session failed", s, err);
          failures.push(s.name || s.id || "?");
        }
      }

      const listed = await invoke<BackendSessionInfo[]>("list_sessions");
      if (listed.length === 0) {
        await bootDefaultSession();
      } else {
        // Preserve restore order from disk, not backend map order.
        const byId = new Map(listed.map((s) => [s.id, backendToSession(s)]));
        const ordered: SessionInfo[] = [];
        for (const s of saved.sessions) {
          const live = byId.get(s.id);
          if (live) ordered.push(live);
        }
        for (const s of listed) {
          if (!ordered.some((o) => o.id === s.id)) {
            ordered.push(backendToSession(s));
          }
        }
        sessions.set(ordered);

        const ids = new Set(ordered.map((s) => s.id));
        const sticky =
          (saved.stickySessionId && ids.has(saved.stickySessionId)
            ? saved.stickySessionId
            : null) ??
          ordered[0]?.id ??
          null;
        const active =
          (saved.activeSessionId && ids.has(saved.activeSessionId)
            ? saved.activeSessionId
            : null) ?? sticky;
        stickySessionId.set(sticky);
        activeSessionId.set(active);
        messages.set(normalizeLoadedMessages(saved.messages ?? []));

        // Re-open session terminal if it was open last time.
        const expanded =
          saved.expandedSessionId && ids.has(saved.expandedSessionId)
            ? saved.expandedSessionId
            : null;
        if (expanded) {
          openExpandedSession(expanded);
        }

        if (failures.length) {
          pushToast(
            "warn",
            `Could not restore: ${failures.map((n) => `@${n}`).join(", ")}`,
          );
        }
      }
    } else {
      await bootDefaultSession();
    }
    connected.set(true);

    // Host-local backend: tmux enables reattach after quit (not required on SSH remotes).
    try {
      const backend = await invoke<string>("session_host_backend");
      if (backend === "plain") {
        pushToast(
          "info",
          "tmux not found on this machine — sessions won't reattach after quit. Install tmux on the Chatty host for durable sessions.",
        );
      }
    } catch {
      /* ignore */
    }
  } catch (err) {
    backendError.set(String(err));
    connected.set(false);
    resumePersistence();
    throw err;
  }

  // Debounced persistence of sessions + chat history.
  storeUnsubs.push(sessions.subscribe(() => scheduleSaveAppState()));
  storeUnsubs.push(messages.subscribe(() => scheduleSaveAppState()));
  storeUnsubs.push(stickySessionId.subscribe(() => scheduleSaveAppState()));
  storeUnsubs.push(activeSessionId.subscribe(() => scheduleSaveAppState()));
  storeUnsubs.push(expandedSessionId.subscribe(() => scheduleSaveAppState()));
  resumePersistence();
  // Capture restored state promptly.
  scheduleSaveAppState(300);
}

async function attachSessionListeners(): Promise<void> {
  // Early paint: backend emits this as soon as the slot is reserved (before fork/exec).
  unlistens.push(
    await listen<BackendSessionInfo>("session-created", (event) => {
      const session = backendToSession(event.payload, { starting: true });
      upsertSession(session);
    }),
  );

  unlistens.push(
    await listen<SessionOutputEvent>("session-output", (event) => {
      const { sessionId, chunk } = event.payload;
      if (!chunk) return;
      appendPty(sessionId, chunk);
    }),
  );

  unlistens.push(
    await listen<SessionStatusEvent>("session-status", (event) => {
      setSessionProcessStatus(event.payload.sessionId, event.payload.status);
    }),
  );

  unlistens.push(
    await listen<SessionExitEvent>("session-exit", (event) => {
      const { sessionId } = event.payload;
      // If we already closed/removed this session, ignore natural exit noise.
      if (!get(sessions).some((s) => s.id === sessionId)) return;
      setSessionProcessStatus(sessionId, "exited");
      if (getSessionTurn(sessionId)) {
        sealTurn(sessionId, "error");
        clearTimers(sessionId);
      }
    }),
  );

  unlistens.push(
    await listen<SessionRemovedEvent>("session-removed", (event) => {
      forgetSessionLocally(event.payload.sessionId);
      scheduleSaveAppState();
    }),
  );

  unlistens.push(
    await listen<BackendSessionInfo>("session-renamed", (event) => {
      const { id, name } = event.payload;
      if (id && name) applySessionRename(id, name);
      scheduleSaveAppState();
    }),
  );

  // Host-local tmux: process-level busy/TUI/cwd (source of truth for inject/close).
  unlistens.push(
    await listen<SessionActivityEvent>("session-activity", (event) => {
      handleTmuxActivity(event.payload);
    }),
  );
}

function handleTmuxActivity(ev: SessionActivityEvent) {
  const { sessionId, activity, command, cwd } = ev;

  const turn = getSessionTurn(sessionId);
  const age = turn ? Date.now() - turn.startedAt : 0;

  // After Enter the pane still shows the shell for a beat. Don't clear the
  // optimistic "busy" indicator until the process had a chance to appear —
  // unless we already saw a non-shell process earlier in this turn.
  if (
    activity === "idle" &&
    turn &&
    age < 450 &&
    !turnSawProcess.has(sessionId) &&
    !turn.pausedForTui
  ) {
    if (cwd && cwd.length > 0) {
      // cwd-only touch without flipping activity
      applySessionActivityPoll(sessionId, "busy", turn.command, cwd);
    }
    return;
  }

  applySessionActivityPoll(sessionId, activity, command, cwd);

  if (activity === "tui") {
    turnSawProcess.add(sessionId);
    if (turn && !turn.pausedForTui) {
      patchSessionTurn(sessionId, { pausedForTui: true });
      clearTimers(sessionId);
      updateTurnBubble(turn.messageId, "[interactive UI running — open session view]", {
        open: true,
        turnStatus: "tui",
      });
    }
    return;
  }

  if (activity === "busy") {
    turnSawProcess.add(sessionId);
    if (turn?.pausedForTui) {
      patchSessionTurn(sessionId, { pausedForTui: false });
    }
    // Keep quiet-seal armed; it acts as backup if we miss the idle transition.
    return;
  }

  // idle — shell is foreground again → clear busy indicator and seal open turns
  if (!turn) {
    turnSawProcess.delete(sessionId);
    return;
  }
  // Seal once we've either seen a real process, got output, or waited long
  // enough that a fast command must have finished (poll re-emits idle).
  const fastDone =
    turn.sawChunk &&
    turn.firstChunkAt != null &&
    Date.now() - turn.firstChunkAt >= MIN_AFTER_FIRST_CHUNK_MS;
  const waitedOut = age >= 700;
  if (
    !turnSawProcess.has(sessionId) &&
    !turn.pausedForTui &&
    !fastDone &&
    !waitedOut
  ) {
    return;
  }
  if (turn.pausedForTui) {
    sealTurn(sessionId, "tui");
  } else {
    sealTurn(sessionId, "ok");
  }
  clearTimers(sessionId);
  turnSawProcess.delete(sessionId);
}

async function bootDefaultSession() {
  const info = await invoke<BackendSessionInfo>("ensure_local_session");
  const session = backendToSession(info);
  upsertSession(session);
  activeSessionId.set(session.id);
  stickySessionId.set(session.id);
  expandedSessionId.set(null);
  const listed = await invoke<BackendSessionInfo[]>("list_sessions");
  sessions.set(listed.map((s) => backendToSession(s)));
  messages.set([]);
}

/** Drop frontend bookkeeping for a session (PTY scrollback, turns, stores). */
function forgetSessionLocally(sessionId: string) {
  if (getSessionTurn(sessionId)) {
    sealTurn(sessionId, "error");
    clearTimers(sessionId);
  }
  ptyScrollback.delete(sessionId);
  termLineBuf.delete(sessionId);
  resetAltScreenCarry(sessionId);
  removeSession(sessionId);
}

/**
 * Spawn a new interactive shell session (unique @name).
 * Optional `name` is sanitized; if taken, backend suffixes -2, -3, …
 *
 * The rail updates as soon as the backend emits `session-created` (before the
 * login shell finishes forking). This promise resolves when the PTY is ready.
 */
export async function createSession(name?: string): Promise<SessionInfo> {
  const info = await invoke<BackendSessionInfo>("create_session", {
    name: name?.trim() ? name.trim() : null,
    id: null,
    cwd: null,
  });
  const session = backendToSession(info, { starting: false });
  upsertSession(session);
  markSessionReady(session.id);
  activeSessionId.set(session.id);
  stickySessionId.set(session.id);
  backendError.set(null);
  scheduleSaveAppState(200);
  return session;
}

/**
 * Kill and remove a session. Chat bubbles for that session stay in history.
 * Refuses to remove the last remaining session (creates none automatically).
 * Busy/TUI: confirm once, then kill (tmux kill-session destroys the work).
 */
export async function closeSession(sessionId: string): Promise<void> {
  const list = get(sessions);
  if (list.length <= 1) {
    pushToast(
      "warn",
      "Cannot remove the last session — add another first.",
    );
    return;
  }
  const session = list.find((s) => s.id === sessionId);
  if (!session) {
    throw new Error("Session not found");
  }

  if (sessionIsTui(session) || session.activity === "busy") {
    const kind = sessionIsTui(session) ? "interactive UI" : "running command";
    const what = session.lastCommand ?? kind;
    const ok = window.confirm(
      `Kill ${what} in @${session.name} and remove this session?\n\n` +
        (session.backend === "tmux"
          ? "This ends the host tmux session (not recoverable by reattach)."
          : "This kills the shell process."),
    );
    if (!ok) return;
  }

  await invoke("close_session", { sessionId });
  // Also handled by session-removed; call locally so UI updates immediately.
  forgetSessionLocally(sessionId);
  backendError.set(null);
  scheduleSaveAppState(100);
}

/**
 * Rename a session for @mentions. Names are sanitized (letters, numbers, . _ -)
 * and must be unique across sessions.
 */
export async function renameSession(
  sessionId: string,
  name: string,
): Promise<SessionInfo> {
  const trimmed = name.trim();
  if (!trimmed) {
    throw new Error("Name cannot be empty");
  }
  const info = await invoke<BackendSessionInfo>("rename_session", {
    sessionId,
    name: trimmed,
  });
  applySessionRename(info.id, info.name);
  backendError.set(null);
  scheduleSaveAppState(200);
  return backendToSession(info);
}

export async function teardownSessionBridge(
  opts: { persist?: boolean } = {},
): Promise<void> {
  const shouldPersist = opts.persist !== false;
  if (shouldPersist) {
    try {
      await flushSaveAppState();
    } catch {
      /* ignore */
    }
  }
  pausePersistence();
  clearAllTimers();
  while (unlistens.length) {
    try {
      unlistens.pop()?.();
    } catch {
      /* ignore */
    }
  }
  while (storeUnsubs.length) {
    try {
      storeUnsubs.pop()?.();
    } catch {
      /* ignore */
    }
  }
  rawListeners.clear();
  rawPending.clear();
  rawFlushScheduled = false;
  activeTurns.set(new Map());
  ptyScrollback.clear();
  termLineBuf.clear();
  resetAltScreenCarry();
}

/** Flush persisted state (call before app quit). */
export async function persistAppStateNow(): Promise<void> {
  await flushSaveAppState();
}

/**
 * Composer / programmatic: arm capture, then write command+CR to the PTY.
 */
export async function beginTurnAndSend(
  session: SessionInfo,
  command: string,
  display: string,
  source: TurnSource,
): Promise<void> {
  startTurnCapture(session, command, display, source);
  const payload =
    command.endsWith("\r") || command.endsWith("\n") ? command : `${command}\r`;
  await invoke("send_raw", {
    sessionId: session.id,
    bytes: Array.from(new TextEncoder().encode(payload)),
  });
}

function sessionIsTui(s: SessionInfo): boolean {
  // Prefer activity from tmux poll (or CSI path for plain backends).
  return s.activity === "tui" || !!s.tuiActive;
}

function sessionIsStarting(s: SessionInfo): boolean {
  return !!s.starting || s.status === "starting";
}

export async function sendCommand(text: string): Promise<void> {
  const trimmed = text.replace(/\s+$/, "");
  if (!trimmed) return;
  // Composer stays available even if a session terminal / TUI is open.
  // We only refuse to *inject* into a session that is currently in TUI mode.
  // Other sessions stay fully usable in parallel.

  const sticky = get(stickySessionId) ?? get(activeSessionId);
  const parsed = parseComposer(trimmed, get(sessions), sticky);
  if (parsed.targets.length === 0) return;

  if (parsed.stickyOnly) {
    const t = parsed.targets[0]!;
    stickySessionId.set(t.id);
    activeSessionId.set(t.id);
    return;
  }

  const starting = parsed.targets.filter(sessionIsStarting);
  if (starting.length) {
    const names = starting.map((t) => `@${t.name}`).join(", ");
    throw new Error(`${names} is still starting — try again in a moment.`);
  }

  const targets = parsed.targets.map(
    (t) => get(sessions).find((s) => s.id === t.id) ?? t,
  );

  const blocked = targets.filter(sessionIsTui);
  // Inject is fine while busy (new line); blocked only for TUI.
  const injectTargets = targets.filter((t) => !sessionIsTui(t));

  if (blocked.length && injectTargets.length === 0) {
    const names = blocked.map((t) => `@${t.name}`).join(", ");
    pushToast(
      "warn",
      `${names} is in interactive UI — open the session, @mention another, or Ctrl+C to interrupt.`,
    );
    return;
  }

  if (blocked.length) {
    const names = blocked.map((t) => `@${t.name}`).join(", ");
    const used = injectTargets.map((t) => `@${t.name}`).join(", ");
    pushToast("warn", `Skipped ${names} (interactive UI) · ran on ${used}`);
  }

  // Fire in parallel — each session has its own turn capture.
  await Promise.all(
    injectTargets.map((target) => {
      const label =
        targets.length > 1
          ? `@${target.name} ${parsed.command}`
          : parsed.display;
      return beginTurnAndSend(target, parsed.command, label, "composer");
    }),
  );
}

/** Debounce accidental double-CR from the emulator or key repeat. */
let lastEnterSentAt = 0;
const ENTER_DEBOUNCE_MS = 45;

/**
 * Normalize input for a Unix PTY: a real TTY sends CR only for Enter.
 * Sending CR+LF (or LF after CR) makes many shells accept the line twice.
 */
function normalizePtyInput(data: string): string {
  // CRLF → CR, then lone LF → CR (paste / Windows-style endings)
  return data.replace(/\r\n/g, "\r").replace(/\n/g, "\r");
}

type PreparedWrite = {
  /** Bytes to write to the PTY (Enter normalized to single CR). */
  toSend: string;
  /** Non-null when this write completes a shell line (for chat turn). */
  completedLine: string | null;
};

/**
 * Track terminal keystrokes for chat mirroring. Does NOT arm turns yet —
 * that happens after the PTY write succeeds (avoids re-render/SIGWINCH
 * before the shell sees Enter — a common "double Enter" cause).
 */
export function prepareTerminalWrite(sessionId: string, data: string): PreparedWrite {
  if (get(altScreenSessions).has(sessionId)) {
    termLineBuf.set(sessionId, "");
    return { toSend: normalizePtyInput(data), completedLine: null };
  }

  let buf = termLineBuf.get(sessionId) ?? "";
  let completedLine: string | null = null;
  let out = "";

  const normalized = normalizePtyInput(data);

  for (const ch of normalized) {
    if (ch === "\r") {
      const line = buf.replace(/\s+$/, "");
      buf = "";
      if (line) completedLine = line;
      // Only one CR; drop debounced duplicates
      const now = Date.now();
      if (now - lastEnterSentAt >= ENTER_DEBOUNCE_MS) {
        out += "\r";
        lastEnterSentAt = now;
      }
      continue;
    }
    if (ch === "\x7f" || ch === "\b") {
      buf = buf.slice(0, -1);
      out += ch;
      continue;
    }
    if (ch >= " " || ch === "\t") {
      buf += ch;
    }
    out += ch;
  }
  termLineBuf.set(sessionId, buf);
  return { toSend: out, completedLine };
}

function armTerminalTurn(sessionId: string, line: string) {
  const turn = getSessionTurn(sessionId);
  if (
    turn &&
    turn.source === "composer" &&
    turn.command === line &&
    Date.now() - turn.startedAt < 800
  ) {
    return;
  }

  const session = get(sessions).find((s) => s.id === sessionId);
  if (!session) return;

  startTurnCapture(session, line, line, "terminal");
}

/**
 * Write to the interactive PTY.
 * Order: normalize Enter → write CR once → then arm chat capture.
 */
export async function sendRawToSession(sessionId: string, data: string): Promise<void> {
  let toSend = data;
  let completedLine: string | null = null;

  if (get(expandedSessionId) === sessionId) {
    const prep = prepareTerminalWrite(sessionId, data);
    toSend = prep.toSend;
    completedLine = prep.completedLine;
  } else {
    toSend = normalizePtyInput(data);
  }

  if (!toSend) {
    // Still arm turn if we had a line but CR was debounced? No — no write, no turn.
    return;
  }

  await invoke("send_raw", {
    sessionId,
    bytes: Array.from(new TextEncoder().encode(toSend)),
  });

  // Arm AFTER the shell has received Enter, so UI updates/resizes can't
  // interleave with accept-line (double-Enter symptom).
  if (completedLine) {
    armTerminalTurn(sessionId, completedLine);
  }
}

export const CTRL = {
  C: 0x03,
  D: 0x04,
  Z: 0x1a,
  BACKSLASH: 0x1c,
} as const;

/**
 * Send a control byte (e.g. ^C) to one session.
 * Works even in TUI mode — interrupts are always allowed.
 */
export async function sendControl(
  label: string,
  byte: number,
  sessionId?: string | null,
): Promise<void> {
  const id = sessionId ?? get(stickySessionId) ?? get(activeSessionId);
  if (!id) return;
  await sendControlToSession(id, label, byte);
}

async function sendControlToSession(
  sessionId: string,
  _label: string,
  byte: number,
): Promise<void> {
  // ^C: seal an open line-turn if any (builds); TUI may stay until it exits alt-screen.
  if (byte === CTRL.C) {
    const turn = getSessionTurn(sessionId);
    if (turn && !turn.pausedForTui) {
      setTimeout(() => {
        const t = getSessionTurn(sessionId);
        if (t && t.turnId === turn.turnId && !t.pausedForTui) {
          sealTurn(sessionId, "error");
          clearTimers(sessionId);
        }
      }, 500);
    }
  }

  await invoke("send_raw", {
    sessionId,
    bytes: [byte],
  });
}

/**
 * Resolve which session(s) get a shell signal:
 * - Leading `@name` / `@a, @b` in the composer → those sessions
 * - Otherwise sticky / active
 *
 * Example: type `@local-2` then Ctrl+C to interrupt htop on local-2
 * without changing sticky permanently (unless you Enter to set sticky).
 */
export function resolveControlTargets(composerText?: string | null): SessionInfo[] {
  const list = get(sessions);
  const sticky = get(stickySessionId) ?? get(activeSessionId);

  if (composerText != null && composerText.trim()) {
    const { targets, missing } = parseLeadingMentions(composerText, list);
    if (missing.length) {
      pushToast(
        "warn",
        `Unknown session: ${missing.map((n) => `@${n}`).join(", ")}`,
      );
    }
    if (targets.length) return targets;
  }

  const fallback = list.find((s) => s.id === sticky) ?? list[0];
  return fallback ? [fallback] : [];
}

/**
 * Send a control byte to every resolved target (mentions or sticky).
 */
export async function sendControlToTargets(
  label: string,
  byte: number,
  composerText?: string | null,
): Promise<void> {
  const targets = resolveControlTargets(composerText);
  if (targets.length === 0) return;

  await Promise.all(
    targets.map((s) => sendControlToSession(s.id, label, byte)),
  );

  // Soft feedback when interrupting a non-sticky mention (easy to miss).
  if (targets.length === 1) {
    const sticky = get(stickySessionId) ?? get(activeSessionId);
    if (targets[0]!.id !== sticky) {
      pushToast("info", `Sent ${label} → @${targets[0]!.name}`);
    }
  } else if (targets.length > 1) {
    pushToast(
      "info",
      `Sent ${label} → ${targets.map((t) => `@${t.name}`).join(", ")}`,
    );
  }
}

export async function resizeSession(
  sessionId: string,
  cols: number,
  rows: number,
): Promise<void> {
  await invoke("resize_session", { sessionId, cols, rows });
}

export function controlFromKeyboard(e: KeyboardEvent): { label: string; byte: number } | null {
  if (!(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey) return null;
  switch (e.code) {
    case "KeyC":
      return { label: "^C", byte: CTRL.C };
    case "KeyD":
      return { label: "^D", byte: CTRL.D };
    case "KeyZ":
      return { label: "^Z", byte: CTRL.Z };
    case "Backslash":
      return { label: "^\\", byte: CTRL.BACKSLASH };
    default:
      return null;
  }
}

export function openExpandedSession(sessionId: string) {
  activeSessionId.set(sessionId);
  stickySessionId.set(sessionId);
  expandedSessionId.set(sessionId);
  termLineBuf.set(sessionId, "");
}

export function closeExpandedSession() {
  expandedSessionId.set(null);
}
