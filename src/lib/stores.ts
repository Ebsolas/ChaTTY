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
  Conversation,
  ConversationFocus,
  SessionActivity,
  SessionInfo,
  TurnStatus,
} from "./types";
import {
  CONVO_MAIN_ID,
  DEFAULT_CONVERSATIONS,
} from "./types";

export const sessions = writable<SessionInfo[]>([]);
export const messages = writable<ChatMessage[]>([]);
export const activeSessionId = writable<string | null>(null);
export const stickySessionId = writable<string | null>(null);
export const backendError = writable<string | null>(null);
export const connected = writable(false);
export const expandedSessionId = writable<string | null>(null);

/** Ordered conversation list (create / rename / delete / reorder). */
export const conversations = writable<Conversation[]>([...DEFAULT_CONVERSATIONS]);
export const activeConversationId = writable<string>(CONVO_MAIN_ID);
/** Focus snapshot per conversation for unload/restore on switch. */
export const conversationFocus = writable<Record<string, ConversationFocus>>({});

export const activeSessions = derived(
  [sessions, activeConversationId],
  ([$sessions, $convoId]) => $sessions.filter((s) => s.conversationId === $convoId),
);

export const activeMessages = derived(
  [messages, activeConversationId],
  ([$messages, $convoId]) => $messages.filter((m) => m.conversationId === $convoId),
);

export function sessionsInConversation(conversationId: string): SessionInfo[] {
  return get(sessions).filter((s) => s.conversationId === conversationId);
}

function snapshotFocus(convoId: string) {
  conversationFocus.update((map) => ({
    ...map,
    [convoId]: {
      stickySessionId: get(stickySessionId),
      activeSessionId: get(activeSessionId),
    },
  }));
}

/**
 * Unload previous conversation UI focus and restore the target.
 * PTYs keep running; only sticky/active/expanded selection changes.
 */
export function setActiveConversation(conversationId: string) {
  const list = get(conversations);
  if (!list.some((c) => c.id === conversationId)) return;
  const prev = get(activeConversationId);
  if (prev === conversationId) return;

  if (prev && list.some((c) => c.id === prev)) snapshotFocus(prev);

  const exp = get(expandedSessionId);
  if (exp) {
    const sess = get(sessions).find((s) => s.id === exp);
    if (!sess || sess.conversationId !== conversationId) {
      expandedSessionId.set(null);
    }
  }

  activeConversationId.set(conversationId);

  const focus = get(conversationFocus)[conversationId];
  const inConvo = sessionsInConversation(conversationId);
  const ids = new Set(inConvo.map((s) => s.id));
  const sticky =
    (focus?.stickySessionId && ids.has(focus.stickySessionId)
      ? focus.stickySessionId
      : null) ??
    inConvo[0]?.id ??
    null;
  const active =
    (focus?.activeSessionId && ids.has(focus.activeSessionId)
      ? focus.activeSessionId
      : null) ?? sticky;
  stickySessionId.set(sticky);
  activeSessionId.set(active);
}

function uniqueConversationName(base: string, excludeId?: string): string {
  const cleaned = base.trim() || "Conversation";
  const names = new Set(
    get(conversations)
      .filter((c) => c.id !== excludeId)
      .map((c) => c.name.toLowerCase()),
  );
  if (!names.has(cleaned.toLowerCase())) return cleaned;
  for (let n = 2; n < 1000; n++) {
    const candidate = `${cleaned} ${n}`;
    if (!names.has(candidate.toLowerCase())) return candidate;
  }
  return `${cleaned} ${crypto.randomUUID().slice(0, 6)}`;
}

/** Create a conversation and switch to it (no session yet — caller may spawn one). */
export function createConversation(name?: string): Conversation {
  const id = `convo-${crypto.randomUUID()}`;
  const convo: Conversation = {
    id,
    name: uniqueConversationName(name?.trim() || "Conversation"),
  };
  conversations.update((list) => [...list, convo]);
  conversationFocus.update((map) => ({
    ...map,
    [id]: { stickySessionId: null, activeSessionId: null },
  }));
  setActiveConversation(id);
  return convo;
}

export function renameConversation(conversationId: string, name: string): Conversation {
  const next = name.trim();
  if (!next) throw new Error("Name cannot be empty");
  const list = get(conversations);
  const cur = list.find((c) => c.id === conversationId);
  if (!cur) throw new Error("Conversation not found");
  if (next.toLowerCase() === cur.name.toLowerCase()) return cur;

  const taken = list.some(
    (c) => c.id !== conversationId && c.name.toLowerCase() === next.toLowerCase(),
  );
  if (taken) throw new Error(`Name already used: ${next}`);

  const updated = { ...cur, name: next };
  conversations.update((all) =>
    all.map((c) => (c.id === conversationId ? updated : c)),
  );
  return updated;
}

/**
 * Remove a conversation from the list (sessions/messages must already be cleaned up).
 * Switches to another convo if available; leaves zero conversations if it was the last
 * (caller should seed a replacement).
 */
export function removeConversationRecord(conversationId: string): void {
  const list = get(conversations);
  if (!list.some((c) => c.id === conversationId)) {
    throw new Error("Conversation not found");
  }

  const fallback = list.find((c) => c.id !== conversationId) ?? null;
  if (get(activeConversationId) === conversationId) {
    if (fallback) {
      setActiveConversation(fallback.id);
    } else {
      expandedSessionId.set(null);
      stickySessionId.set(null);
      activeSessionId.set(null);
      activeConversationId.set("");
    }
  }

  conversations.update((all) => all.filter((c) => c.id !== conversationId));
  conversationFocus.update((map) => {
    const next = { ...map };
    delete next[conversationId];
    return next;
  });
  messages.update((all) => all.filter((m) => m.conversationId !== conversationId));
}

/** Reorder by moving `conversationId` to `toIndex` (0-based). */
export function reorderConversation(conversationId: string, toIndex: number): void {
  const list = get(conversations);
  const from = list.findIndex((c) => c.id === conversationId);
  if (from < 0) return;
  const clamped = Math.max(0, Math.min(list.length - 1, toIndex));
  if (from === clamped) return;
  const next = [...list];
  const [item] = next.splice(from, 1);
  next.splice(clamped, 0, item!);
  conversations.set(next);
}

/** Move conversation up (-1) or down (+1) in the rail. */
export function moveConversation(conversationId: string, delta: -1 | 1): void {
  const list = get(conversations);
  const from = list.findIndex((c) => c.id === conversationId);
  if (from < 0) return;
  reorderConversation(conversationId, from + delta);
}

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
  opts?: { starting?: boolean; conversationId?: string },
): SessionInfo {
  const starting = opts?.starting === true;
  const conversationId =
    opts?.conversationId || get(activeConversationId) || CONVO_MAIN_ID;
  return {
    id: info.id,
    name: info.name,
    status: starting ? "starting" : info.status,
    cwd: info.cwd ?? "",
    shell: info.shell ?? "",
    shellFlavor: info.shellFlavor ?? "",
    conversationId,
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
    const prev = next[idx]!;
    // Preserve activity/tui flags when a later backend snapshot is thinner.
    // Keep conversationId unless the incoming value is explicitly set & different seed.
    next[idx] = {
      ...prev,
      ...info,
      conversationId: info.conversationId || prev.conversationId,
      activity: info.activity ?? prev.activity,
      tuiActive: info.tuiActive ?? prev.tuiActive,
      starting: info.starting ?? prev.starting,
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
  const removed = get(sessions).find((s) => s.id === sessionId);
  const convoId = removed?.conversationId;
  sessions.update((list) => list.filter((s) => s.id !== sessionId));
  altScreenSessions.update((set) => {
    if (!set.has(sessionId)) return set;
    const next = new Set(set);
    next.delete(sessionId);
    return next;
  });
  setSessionTurn(sessionId, null);
  const remaining = get(sessions);
  const prefer =
    (convoId ? remaining.filter((s) => s.conversationId === convoId) : remaining)[0]
      ?? remaining[0]
      ?? null;
  if (get(activeSessionId) === sessionId) {
    activeSessionId.set(prefer?.id ?? null);
  }
  if (get(stickySessionId) === sessionId) {
    stickySessionId.set(prefer?.id ?? null);
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
  // Svelte notifies subscribers on every `update()` even if the array ref is
  // unchanged (objects always "not equal"). Skip the store write entirely
  // when nothing changed — critical with multi-session + htop redraws.
  const list = get(sessions);
  const cur = list.find((s) => s.id === sessionId);
  if (!cur) return;

  const nextCmd =
    activity === "idle" ? cur.lastCommand : command || cur.lastCommand;
  const nextCwd = cwd && cwd.length > 0 ? cwd : cur.cwd;
  const nextTui = activity === "tui";
  const same =
    cur.activity === activity &&
    cur.tuiActive === nextTui &&
    cur.lastCommand === nextCmd &&
    cur.cwd === nextCwd;

  if (!same) {
    sessions.update((all) =>
      all.map((s) =>
        s.id === sessionId
          ? {
              ...s,
              activity,
              tuiActive: nextTui,
              lastCommand: nextCmd,
              cwd: nextCwd,
            }
          : s,
      ),
    );
  }

  // Only touch alt-screen set when TUI membership might change.
  if (activity === "tui") {
    if (!get(altScreenSessions).has(sessionId)) {
      altScreenSessions.update((set) => {
        const next = new Set(set);
        next.add(sessionId);
        return next;
      });
    }
  } else if (cur.activity === "tui" || get(altScreenSessions).has(sessionId)) {
    if (get(altScreenSessions).has(sessionId)) {
      altScreenSessions.update((set) => {
        const next = new Set(set);
        next.delete(sessionId);
        return next;
      });
    }
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

function conversationIdForSession(sessionId: string): string {
  return (
    get(sessions).find((s) => s.id === sessionId)?.conversationId ??
    get(activeConversationId) ??
    CONVO_MAIN_ID
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
    conversationId: conversationIdForSession(sessionId),
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
    conversationId: conversationIdForSession(sessionId),
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

function shortCommand(cmd: string, max = 48): string {
  const t = cmd.trim().replace(/\s+/g, " ");
  if (t.length <= max) return t;
  return `${t.slice(0, max - 1)}…`;
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

  // Background conversation: balloon when work finishes while you're elsewhere.
  const sess = get(sessions).find((s) => s.id === sessionId);
  const activeConvo = get(activeConversationId);
  if (sess && sess.conversationId !== activeConvo) {
    const convoName =
      get(conversations).find((c) => c.id === sess.conversationId)?.name ??
      "another conversation";
    const cmd = turn.command ? ` · ${shortCommand(turn.command)}` : "";
    pushToast(
      finalStatus === "error" ? "warn" : "info",
      `@${sess.name} finished in ${convoName}${cmd}`,
    );
  }

  setSessionTurn(sessionId, null);
}

/** @deprecated use sealTurn(sessionId) — kept for call sites mid-refactor */
export function sealActiveTurn(status: TurnStatus = "ok") {
  const turn = get(activeTurn);
  if (turn) sealTurn(turn.sessionId, status);
}
