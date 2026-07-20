import { writable, get, derived } from "svelte/store";
import { stripAnsi } from "./ansi";
import {
  DEFAULT_BINDINGS,
  formatChordDisplay,
  mergeKeybindings,
  type ActionId,
  type KeybindingsMap,
} from "./keybindings";
import type {
  BackendSessionInfo,
  ChatMessage,
  SessionActivity,
  SessionInfo,
  TurnStatus,
} from "./types";

export const sessions = writable<SessionInfo[]>([]);
export const messages = writable<ChatMessage[]>([]);
export const activeSessionId = writable<string | null>(null);
export const stickySessionId = writable<string | null>(null);
export const backendError = writable<string | null>(null);
export const connected = writable(false);
export const expandedSessionId = writable<string | null>(null);

/** Soft notices (warnings/info) — bottom-right balloon, not the red error strip. */
export type ToastLevel = "info" | "warn";
export type Toast = {
  id: string;
  level: ToastLevel;
  message: string;
  createdAt: number;
};

export const toasts = writable<Toast[]>([]);

const TOAST_TTL_MS = 5200;

export function pushToast(level: ToastLevel, message: string) {
  const id = crypto.randomUUID();
  const toast: Toast = { id, level, message, createdAt: Date.now() };
  toasts.update((list) => [...list, toast].slice(-4));
  setTimeout(() => dismissToast(id), TOAST_TTL_MS);
}

export function dismissToast(id: string) {
  toasts.update((list) => list.filter((t) => t.id !== id));
}

/** Resolved keybindings (defaults ∪ user config). */
export const keybindings = writable<KeybindingsMap>({ ...DEFAULT_BINDINGS });
/** Path of loaded user keybindings file, if any. */
export const keybindingsSource = writable<string | null>(null);
export const keybindingsConfigDir = writable<string | null>(null);

export function setKeybindings(
  partial: Partial<KeybindingsMap> | Record<string, string>,
  meta?: { sourcePath?: string | null; configDir?: string | null },
) {
  keybindings.set(mergeKeybindings(partial as Partial<KeybindingsMap>));
  if (meta?.sourcePath !== undefined) keybindingsSource.set(meta.sourcePath);
  if (meta?.configDir !== undefined) keybindingsConfigDir.set(meta.configDir);
}

export function chordFor(action: ActionId): string {
  return formatChordDisplay(get(keybindings)[action] ?? DEFAULT_BINDINGS[action]);
}

/** Quiet after last PTY byte while capturing (only after we've seen data). */
export const QUIET_MS = 650;
/** Don't seal until this long after the *first* post-send chunk (avoids `w`-only). */
export const MIN_AFTER_FIRST_CHUNK_MS = 280;
/** Hard max for a turn. */
export const TURN_MAX_MS = 10 * 60 * 1000;

export type TurnSource = "composer" | "terminal";

export type ActiveTurn = {
  turnId: string;
  sessionId: string;
  command: string;
  messageId: string;
  source: TurnSource;
  startedAt: number;
  firstChunkAt: number | null;
  lastChunkAt: number;
  raw: string;
  sawChunk: boolean;
  /** Stop stuffing TUI bytes into the bubble once alt-screen is detected. */
  pausedForTui: boolean;
};

/**
 * One open chat capture per session so TUIs / long builds on @local
 * never block work on @local-2.
 */
export const activeTurns = writable<Map<string, ActiveTurn>>(new Map());

export function getSessionTurn(sessionId: string): ActiveTurn | null {
  return get(activeTurns).get(sessionId) ?? null;
}

export function setSessionTurn(sessionId: string, turn: ActiveTurn | null) {
  activeTurns.update((map) => {
    const next = new Map(map);
    if (turn) next.set(sessionId, turn);
    else next.delete(sessionId);
    return next;
  });
}

export function patchSessionTurn(
  sessionId: string,
  patch: Partial<ActiveTurn> | ((t: ActiveTurn) => ActiveTurn),
) {
  activeTurns.update((map) => {
    const cur = map.get(sessionId);
    if (!cur) return map;
    const next = new Map(map);
    next.set(
      sessionId,
      typeof patch === "function" ? patch(cur) : { ...cur, ...patch },
    );
    return next;
  });
}

/** Prefer sticky/active session's turn for chrome that shows a single command. */
export const activeTurn = derived(
  [activeTurns, stickySessionId, activeSessionId],
  ([$turns, $sticky, $active]) => {
    const prefer = $sticky ?? $active;
    if (prefer && $turns.has(prefer)) return $turns.get(prefer)!;
    const first = $turns.values().next();
    return first.done ? null : first.value;
  },
);

export const isBusy = derived(activeTurns, ($m) => $m.size > 0);

export const busySessionIds = derived(activeTurns, ($m) => [...$m.keys()]);

/** Alt-screen / TUI active on a session — pause terminal→chat line turns. */
export const altScreenSessions = writable<Set<string>>(new Set());

export function isSessionTui(sessionId: string): boolean {
  return get(altScreenSessions).has(sessionId);
}

export function backendToSession(
  info: BackendSessionInfo,
  opts?: { starting?: boolean },
): SessionInfo {
  const starting = opts?.starting === true;
  return {
    id: info.id,
    name: info.name,
    status: starting ? "starting" : info.status,
    cwd: info.cwd ?? "",
    shell: info.shell ?? "",
    shellFlavor: info.shellFlavor ?? "",
    lineageId: info.id,
    parentSessionId: null,
    forkedFromMessageId: null,
    activity: "idle",
    tuiActive: false,
    starting,
    backend: info.backend,
  };
}

export function upsertSession(info: SessionInfo) {
  sessions.update((list) => {
    const idx = list.findIndex((s) => s.id === info.id);
    if (idx === -1) return [...list, info];
    const next = [...list];
    // Preserve activity/tui flags when a later backend snapshot is thinner.
    next[idx] = {
      ...next[idx],
      ...info,
      activity: info.activity ?? next[idx]!.activity,
      tuiActive: info.tuiActive ?? next[idx]!.tuiActive,
      starting: info.starting ?? next[idx]!.starting,
    };
    return next;
  });
}

export function markSessionReady(sessionId: string) {
  sessions.update((list) =>
    list.map((s) =>
      s.id === sessionId
        ? { ...s, starting: false, status: s.status === "starting" ? "running" : s.status }
        : s,
    ),
  );
}

/** Apply a renamed @name and keep chat bubbles in sync. */
export function applySessionRename(sessionId: string, name: string) {
  sessions.update((list) =>
    list.map((s) => (s.id === sessionId ? { ...s, name } : s)),
  );
  messages.update((list) =>
    list.map((m) =>
      m.sessionId === sessionId ? { ...m, sessionName: name } : m,
    ),
  );
}

/** Remove a session from the rail (chat history for that id is kept). */
export function removeSession(sessionId: string) {
  sessions.update((list) => list.filter((s) => s.id !== sessionId));
  altScreenSessions.update((set) => {
    if (!set.has(sessionId)) return set;
    const next = new Set(set);
    next.delete(sessionId);
    return next;
  });
  setSessionTurn(sessionId, null);
  if (get(activeSessionId) === sessionId) {
    const remaining = get(sessions);
    activeSessionId.set(remaining[0]?.id ?? null);
  }
  if (get(stickySessionId) === sessionId) {
    const remaining = get(sessions);
    stickySessionId.set(remaining[0]?.id ?? null);
  }
  if (get(expandedSessionId) === sessionId) {
    expandedSessionId.set(null);
  }
}

export function setSessionProcessStatus(sessionId: string, status: SessionInfo["status"]) {
  sessions.update((list) =>
    list.map((s) => (s.id === sessionId ? { ...s, status } : s)),
  );
}

export function setSessionActivity(
  sessionId: string,
  activity: SessionActivity,
  lastCommand?: string,
) {
  sessions.update((list) =>
    list.map((s) =>
      s.id === sessionId
        ? {
            ...s,
            activity,
            // Activity is authoritative (esp. tmux poll); don't leave stale tuiActive on busy/idle.
            tuiActive: activity === "tui",
            lastCommand: lastCommand !== undefined ? lastCommand : s.lastCommand,
            cwd: s.cwd,
          }
        : s,
    ),
  );
}

/** Apply tmux (or other) activity poll: activity + optional cwd. */
export function applySessionActivityPoll(
  sessionId: string,
  activity: SessionActivity,
  command: string,
  cwd?: string,
) {
  let activityChanged = false;
  sessions.update((list) => {
    let changed = false;
    const next = list.map((s) => {
      if (s.id !== sessionId) return s;
      const nextCmd =
        activity === "idle" ? s.lastCommand : command || s.lastCommand;
      const nextCwd = cwd && cwd.length > 0 ? cwd : s.cwd;
      const nextTui = activity === "tui";
      if (
        s.activity === activity &&
        s.tuiActive === nextTui &&
        s.lastCommand === nextCmd &&
        s.cwd === nextCwd
      ) {
        return s;
      }
      changed = true;
      if (s.activity !== activity) activityChanged = true;
      return {
        ...s,
        activity,
        tuiActive: nextTui,
        lastCommand: nextCmd,
        cwd: nextCwd,
      };
    });
    return changed ? next : list;
  });
  // Only touch alt-screen set when TUI membership might change.
  if (activity === "tui") {
    altScreenSessions.update((set) => {
      if (set.has(sessionId)) return set;
      const next = new Set(set);
      next.add(sessionId);
      return next;
    });
  } else if (activityChanged || activity === "idle" || activity === "busy") {
    altScreenSessions.update((set) => {
      if (!set.has(sessionId)) return set;
      const next = new Set(set);
      next.delete(sessionId);
      return next;
    });
  }
}

export function setSessionTui(sessionId: string, tuiActive: boolean) {
  altScreenSessions.update((set) => {
    const next = new Set(set);
    if (tuiActive) next.add(sessionId);
    else next.delete(sessionId);
    return next;
  });
  sessions.update((list) =>
    list.map((s) => {
      if (s.id !== sessionId) return s;
      if (tuiActive) {
        return { ...s, tuiActive: true, activity: "tui" as const };
      }
      // Leaving TUI: busy if a turn is still open, else idle
      const turn = getSessionTurn(sessionId);
      const busy = !!turn && !turn.pausedForTui;
      return {
        ...s,
        tuiActive: false,
        activity: busy ? ("busy" as const) : ("idle" as const),
      };
    }),
  );
}

export function appendUserMessage(
  body: string,
  sessionId: string,
  sessionName: string | undefined,
  turnId: string,
): ChatMessage {
  const msg: ChatMessage = {
    id: crypto.randomUUID(),
    sessionId,
    role: "user",
    sessionName,
    body,
    createdAt: Date.now(),
    parentId: null,
    streamState: "closed",
    turnId,
  };
  messages.update((m) => [...m, msg]);
  return msg;
}

export function openSessionBubble(
  sessionId: string,
  sessionName: string,
  turnId: string,
): ChatMessage {
  const msg: ChatMessage = {
    id: crypto.randomUUID(),
    sessionId,
    role: "session",
    sessionName,
    body: "",
    createdAt: Date.now(),
    parentId: null,
    streamState: "open",
    turnId,
    turnStatus: "running",
  };
  messages.update((m) => [...m, msg]);
  return msg;
}

export function updateTurnBubble(
  messageId: string,
  body: string,
  opts: { open: boolean; turnStatus?: TurnStatus; exitCode?: number },
) {
  messages.update((list) =>
    list.map((m) =>
      m.id === messageId
        ? {
            ...m,
            body,
            streamState: opts.open ? ("open" as const) : ("closed" as const),
            turnStatus: opts.turnStatus ?? m.turnStatus,
            exitCode: opts.exitCode ?? m.exitCode,
          }
        : m,
    ),
  );
}

/** Format PTY capture into a chat bubble (strip ANSI + command echo + prompt tail). */
export function formatPtyCapture(raw: string, command: string): string {
  let b = stripAnsi(raw).replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  b = stripLeadingCommandEcho(b, command);
  b = stripTrailingPromptLines(b);
  b = b.replace(/^\n+/, "").replace(/\n+$/, "");
  return b;
}

function stripLeadingCommandEcho(body: string, command: string): string {
  const cmd = command.trim();
  if (!cmd) return body;
  const lines = body.split("\n");
  let i = 0;
  while (i < lines.length) {
    const t = lines[i]!.trimEnd();
    if (t === "" || t === cmd || t.trim() === cmd) {
      i++;
      continue;
    }
    // Shell may echo with prompt prefix on same line — drop if ends with cmd
    if (t.endsWith(cmd) && t.length < cmd.length + 80) {
      i++;
      continue;
    }
    break;
  }
  return lines.slice(i).join("\n");
}

function stripTrailingPromptLines(body: string): string {
  const lines = body.split("\n");
  while (lines.length > 0 && isPromptishLine(lines[lines.length - 1]!)) {
    lines.pop();
  }
  while (lines.length > 0 && lines[lines.length - 1]!.trim() === "") {
    lines.pop();
  }
  return lines.join("\n");
}

function isPromptishLine(line: string): boolean {
  const t = line.trim();
  if (!t) return false;
  if (/^[#$%❯›]\s*$/.test(t)) return true;
  if (t.length < 120 && /[#$%❯›]\s*$/.test(t)) return true;
  return false;
}

/** Seal the open turn for a specific session (other sessions keep running). */
export function sealTurn(sessionId: string, status: TurnStatus = "ok") {
  const turn = getSessionTurn(sessionId);
  if (!turn) return;
  let body = formatPtyCapture(turn.raw, turn.command);
  let finalStatus = status;
  const inAlt = get(altScreenSessions).has(sessionId);
  // Bubble/footer can say "tui" when the command entered a UI even if it has since exited.
  if (status === "tui" || turn.pausedForTui || inAlt) {
    body = body
      ? `${body}\n\n[interactive UI — open session view]`
      : "[interactive UI — open session view]";
    finalStatus = "tui";
  }
  updateTurnBubble(turn.messageId, body || "(no output)", {
    open: false,
    turnStatus: finalStatus,
  });
  // Live session activity: sticky TUI only while still in alt-screen.
  if (inAlt) {
    setSessionActivity(sessionId, "tui", turn.command);
  } else {
    setSessionActivity(sessionId, "idle");
  }
  setSessionTurn(sessionId, null);
}

/** @deprecated use sealTurn(sessionId) — kept for call sites mid-refactor */
export function sealActiveTurn(status: TurnStatus = "ok") {
  const turn = get(activeTurn);
  if (turn) sealTurn(turn.sessionId, status);
}
