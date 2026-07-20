/**
 * Unified session hub: one interactive PTY per session.
 * Chat and session terminal are two views of the same shell.
 */

import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { get } from "svelte/store";
import { parseComposer, parseLeadingMentions } from "./mentions";
import { looksLikeTuiNoise, resetAltScreenCarry, scanAltScreen } from "./termDetect";
import {
  activeSessionId,
  activeTurns,
  altScreenSessions,
  appendUserMessage,
  applySessionRename,
  backendError,
  backendToSession,
  connected,
  expandedSessionId,
  formatPtyCapture,
  getSessionTurn,
  markSessionReady,
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
  SessionExitEvent,
  SessionInfo,
  SessionOutputEvent,
  SessionRemovedEvent,
  SessionStatusEvent,
} from "./types";

const unlistens: UnlistenFn[] = [];
const ptyScrollback = new Map<string, string>();
const SCROLLBACK_MAX = 500_000;

/** Per-session quiet / max seal timers (independent captures). */
const quietTimers = new Map<string, ReturnType<typeof setTimeout>>();
const maxTimers = new Map<string, ReturnType<typeof setTimeout>>();

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

  // --- TUI / alternate screen detection (per session, sticky until leave CSI) ---
  let alt = scanAltScreen(sessionId, text);
  // Heuristic: dense redraws with no CSI yet still mean a full-screen app.
  if (alt === null && !get(altScreenSessions).has(sessionId) && looksLikeTuiNoise(text)) {
    alt = "enter";
  }
  if (alt === "enter") {
    enterTuiMode(sessionId);
  } else if (alt === "leave") {
    leaveTuiMode(sessionId);
  }

  notifyRawListeners(sessionId, text);

  const turn = getSessionTurn(sessionId);
  if (!turn) return;
  // Don't accumulate TUI framebuffer noise into the chat capture.
  if (turn.pausedForTui || get(altScreenSessions).has(sessionId)) return;

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
  // Never schedule quiet seals against a known TUI session.
  if (get(altScreenSessions).has(sessionId)) return;

  quietTimers.set(
    sessionId,
    setTimeout(() => {
      const turn = getSessionTurn(sessionId);
      if (!turn) return;

      // Never quiet-seal while a full-screen TUI owns this session.
      if (turn.pausedForTui || get(altScreenSessions).has(sessionId)) {
        return;
      }

      // Wait until we've actually received PTY data for this turn.
      if (!turn.sawChunk || turn.firstChunkAt == null) {
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

      sealTurn(sessionId, "ok");
      clearTimers(sessionId);
    }, QUIET_MS),
  );
}

function armMaxTimer(sessionId: string, turnId: string) {
  const prev = maxTimers.get(sessionId);
  if (prev) clearTimeout(prev);
  // TUIs (htop, ranger, …) can run indefinitely — no hard deadline.
  if (get(altScreenSessions).has(sessionId)) return;

  maxTimers.set(
    sessionId,
    setTimeout(() => {
      const t = getSessionTurn(sessionId);
      if (!t || t.turnId !== turnId) return;
      // Re-check: entered TUI after the timer was armed.
      if (t.pausedForTui || get(altScreenSessions).has(sessionId)) {
        clearTimers(sessionId);
        return;
      }
      sealTurn(sessionId, "ok");
      clearTimers(sessionId);
    }, TURN_MAX_MS),
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
  await teardownSessionBridge();
  backendError.set(null);
  ptyScrollback.clear();
  termLineBuf.clear();

  try {
    const info = await invoke<BackendSessionInfo>("ensure_local_session");
    const session = backendToSession(info);
    upsertSession(session);
    activeSessionId.set(session.id);
    stickySessionId.set(session.id);
    const listed = await invoke<BackendSessionInfo[]>("list_sessions");
    sessions.set(listed.map((s) => backendToSession(s)));
    connected.set(true);
  } catch (err) {
    backendError.set(String(err));
    connected.set(false);
    throw err;
  }

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
    }),
  );

  unlistens.push(
    await listen<BackendSessionInfo>("session-renamed", (event) => {
      const { id, name } = event.payload;
      if (id && name) applySessionRename(id, name);
    }),
  );
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
  });
  const session = backendToSession(info, { starting: false });
  upsertSession(session);
  markSessionReady(session.id);
  activeSessionId.set(session.id);
  stickySessionId.set(session.id);
  backendError.set(null);
  return session;
}

/**
 * Kill and remove a session. Chat bubbles for that session stay in history.
 * Refuses to remove the last remaining session (creates none automatically).
 */
export async function closeSession(sessionId: string): Promise<void> {
  const list = get(sessions);
  if (list.length <= 1) {
    throw new Error("Cannot remove the last session — add another first, or keep one open.");
  }
  if (!list.some((s) => s.id === sessionId)) {
    throw new Error("Session not found");
  }

  await invoke("close_session", { sessionId });
  // Also handled by session-removed; call locally so UI updates immediately.
  forgetSessionLocally(sessionId);
  backendError.set(null);
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
  return backendToSession(info);
}

export async function teardownSessionBridge(): Promise<void> {
  clearAllTimers();
  while (unlistens.length) {
    try {
      unlistens.pop()?.();
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
  return s.activity === "tui" || !!s.tuiActive || get(altScreenSessions).has(s.id);
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

  const blocked = parsed.targets.filter(sessionIsTui);
  const allowed = parsed.targets.filter((t) => !sessionIsTui(t));

  if (blocked.length && allowed.length === 0) {
    const names = blocked.map((t) => `@${t.name}`).join(", ");
    pushToast(
      "warn",
      `${names} is in interactive UI — open the session, @mention another, or Ctrl+C to interrupt.`,
    );
    return;
  }

  if (blocked.length) {
    const names = blocked.map((t) => `@${t.name}`).join(", ");
    const used = allowed.map((t) => `@${t.name}`).join(", ");
    pushToast("warn", `Skipped ${names} (interactive UI) · ran on ${used}`);
  }

  // Fire in parallel — each session has its own turn capture.
  await Promise.all(
    allowed.map((target) => {
      const label =
        parsed.targets.length > 1
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
