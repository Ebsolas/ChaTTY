/**
 * Unified session hub: one interactive PTY per session.
 * Chat and session terminal are two views of the same shell.
 */

import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { get } from "svelte/store";
import { parseComposer } from "./mentions";
import { detectAltScreenChange } from "./termDetect";
import {
  activeSessionId,
  activeTurn,
  altScreenSessions,
  appendUserMessage,
  backendError,
  backendToSession,
  connected,
  expandedSessionId,
  formatPtyCapture,
  MIN_AFTER_FIRST_CHUNK_MS,
  openSessionBubble,
  QUIET_MS,
  sealTurn,
  sessions,
  setSessionActivity,
  setSessionProcessStatus,
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
  SessionStatusEvent,
} from "./types";

const unlistens: UnlistenFn[] = [];
const ptyScrollback = new Map<string, string>();
const SCROLLBACK_MAX = 500_000;

let quietTimer: ReturnType<typeof setTimeout> | null = null;
let maxTimer: ReturnType<typeof setTimeout> | null = null;

type RawListener = (sessionId: string, chunk: string) => void;
const rawListeners = new Set<RawListener>();

/** Keys typed in the session terminal since the last Enter (for chat mirroring). */
const termLineBuf = new Map<string, string>();

export function subscribeRawOutput(fn: RawListener): () => void {
  rawListeners.add(fn);
  return () => rawListeners.delete(fn);
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

  // --- TUI / alternate screen detection ---
  const alt = detectAltScreenChange(text);
  if (alt === "enter") {
    setSessionTui(sessionId, true);
    termLineBuf.set(sessionId, "");
    const turn = get(activeTurn);
    if (turn && turn.sessionId === sessionId && !turn.pausedForTui) {
      // Stop stuffing redraws into the chat bubble; leave a clear marker.
      activeTurn.update((t) => (t ? { ...t, pausedForTui: true } : t));
      clearTimers(); // don't quiet-seal mid-TUI
      updateTurnBubble(turn.messageId, "[interactive UI running — open session view]", {
        open: true,
        turnStatus: "tui",
      });
    }
  } else if (alt === "leave") {
    setSessionTui(sessionId, false);
    const turn = get(activeTurn);
    if (turn && turn.sessionId === sessionId && turn.pausedForTui) {
      // TUI exited; seal the turn as tui-completed.
      sealTurn("tui");
      clearTimers();
    }
  }

  for (const fn of rawListeners) {
    try {
      fn(sessionId, text);
    } catch {
      /* ignore */
    }
  }

  const turn = get(activeTurn);
  if (!turn || turn.sessionId !== sessionId) return;
  // Don't accumulate TUI framebuffer noise into the chat capture.
  if (turn.pausedForTui || get(altScreenSessions).has(sessionId)) return;

  const now = Date.now();
  const raw = turn.raw + text;
  activeTurn.update((t) =>
    t
      ? {
          ...t,
          raw,
          sawChunk: true,
          firstChunkAt: t.firstChunkAt ?? now,
          lastChunkAt: now,
        }
      : t,
  );
  updateTurnBubble(turn.messageId, formatPtyCapture(raw, turn.command) || "…", {
    open: true,
    turnStatus: "running",
  });
  scheduleQuietSeal();
}

function clearTimers() {
  if (quietTimer) {
    clearTimeout(quietTimer);
    quietTimer = null;
  }
  if (maxTimer) {
    clearTimeout(maxTimer);
    maxTimer = null;
  }
}

function scheduleQuietSeal() {
  if (quietTimer) clearTimeout(quietTimer);
  quietTimer = setTimeout(() => {
    const turn = get(activeTurn);
    if (!turn) return;

    // Never quiet-seal while a full-screen TUI owns the session.
    if (turn.pausedForTui || get(altScreenSessions).has(turn.sessionId)) {
      return;
    }

    // Wait until we've actually received PTY data for this turn.
    if (!turn.sawChunk || turn.firstChunkAt == null) {
      scheduleQuietSeal();
      return;
    }
    const sinceFirst = Date.now() - turn.firstChunkAt;
    if (sinceFirst < MIN_AFTER_FIRST_CHUNK_MS) {
      scheduleQuietSeal();
      return;
    }

    // Don't seal empty if data might still be coming (Starship/slow cmds).
    const body = formatPtyCapture(turn.raw, turn.command);
    const sinceLast = Date.now() - turn.lastChunkAt;
    if (!body && sinceLast < 1500) {
      scheduleQuietSeal();
      return;
    }

    sealTurn("ok");
    clearTimers();
  }, QUIET_MS);
}

function armMaxTimer(turnId: string) {
  if (maxTimer) clearTimeout(maxTimer);
  maxTimer = setTimeout(() => {
    const t = get(activeTurn);
    if (t && t.turnId === turnId) {
      sealTurn("ok");
      clearTimers();
    }
  }, TURN_MAX_MS);
}

/** Synchronous turn arming — must run before any PTY write for that turn. */
function startTurnCapture(
  session: SessionInfo,
  command: string,
  display: string,
  source: TurnSource,
): string {
  if (get(activeTurn)) {
    sealTurn("ok");
    clearTimers();
  }

  const turnId = crypto.randomUUID();
  appendUserMessage(display, session.id, session.name, turnId);
  const bubble = openSessionBubble(session.id, session.name, turnId);
  activeTurn.set({
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
  // If already in TUI, mark busy-as-tui
  if (get(altScreenSessions).has(session.id)) {
    setSessionActivity(session.id, "tui", command);
    activeTurn.update((t) => (t ? { ...t, pausedForTui: true } : t));
  } else {
    setSessionActivity(session.id, "busy", command);
  }
  activeSessionId.set(session.id);
  stickySessionId.set(session.id);
  armMaxTimer(turnId);
  scheduleQuietSeal();
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
    sessions.set(listed.map(backendToSession));
    connected.set(true);
  } catch (err) {
    backendError.set(String(err));
    connected.set(false);
    throw err;
  }

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
      setSessionProcessStatus(event.payload.sessionId, "exited");
      if (get(activeTurn)?.sessionId === event.payload.sessionId) {
        sealTurn("error");
        clearTimers();
      }
    }),
  );
}

export async function teardownSessionBridge(): Promise<void> {
  clearTimers();
  while (unlistens.length) {
    try {
      unlistens.pop()?.();
    } catch {
      /* ignore */
    }
  }
  rawListeners.clear();
  activeTurn.set(null);
  ptyScrollback.clear();
  termLineBuf.clear();
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

export async function sendCommand(text: string): Promise<void> {
  const trimmed = text.replace(/\s+$/, "");
  if (!trimmed) return;
  // Composer stays available even if the session terminal / TUI is open.
  // We only refuse to *inject* into a session that is currently in TUI mode.

  const sticky = get(stickySessionId) ?? get(activeSessionId);
  const parsed = parseComposer(trimmed, get(sessions), sticky);
  if (parsed.targets.length === 0) return;

  if (parsed.stickyOnly) {
    const t = parsed.targets[0]!;
    stickySessionId.set(t.id);
    activeSessionId.set(t.id);
    return;
  }

  const blocked = parsed.targets.filter(sessionIsTui);
  const allowed = parsed.targets.filter((t) => !sessionIsTui(t));

  if (blocked.length && allowed.length === 0) {
    const names = blocked.map((t) => `@${t.name}`).join(", ");
    throw new Error(
      `${names} is in interactive UI (TUI) — open the session view; chat won't inject keys into a full-screen app.`,
    );
  }

  if (blocked.length) {
    const names = blocked.map((t) => `@${t.name}`).join(", ");
    backendError.set(`Skipped TUI session(s): ${names}`);
  } else {
    backendError.set(null);
  }

  for (const target of allowed) {
    const label =
      parsed.targets.length > 1
        ? `@${target.name} ${parsed.command}`
        : parsed.display;
    await beginTurnAndSend(target, parsed.command, label, "composer");
    await waitForTurnIdle();
  }
}

function waitForTurnIdle(): Promise<void> {
  return new Promise((resolve) => {
    if (!get(activeTurn)) {
      resolve();
      return;
    }
    const unsub = activeTurn.subscribe((t) => {
      if (!t) {
        unsub();
        resolve();
      }
    });
  });
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
  const turn = get(activeTurn);
  if (
    turn &&
    turn.sessionId === sessionId &&
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

export async function sendControl(label: string, byte: number): Promise<void> {
  const sessionId = get(stickySessionId) ?? get(activeSessionId);
  if (!sessionId) return;

  if (byte === CTRL.C && get(activeTurn)?.sessionId === sessionId) {
    setTimeout(() => {
      if (get(activeTurn)?.sessionId === sessionId) {
        sealTurn("error");
        clearTimers();
      }
    }, 500);
  }

  // Ctrl+C etc. shouldn't go through line buffering as text.
  await invoke("send_raw", {
    sessionId,
    bytes: [byte],
  });
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
