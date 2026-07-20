/** Domain types — shell-agnostic session service + fork-ready fields. */

export type ProcessStatus = "starting" | "running" | "exited";
/** idle = at prompt; busy = line command in flight; tui = full-screen app */
export type SessionActivity = "idle" | "busy" | "tui";
export type TurnStatus = "running" | "ok" | "error" | "tui";

/** Default ids for first boot / migration. */
export const GROUP_DEFAULT_ID = "group-default";
export const CONVO_MAIN_ID = "convo-main";
export const CONVO_SCRATCH_ID = "convo-scratch";

export const GROUP_COLORS = [
  "#4c8dff",
  "#3dd68c",
  "#f0b429",
  "#e35d6a",
  "#c792ea",
  "#89ddff",
  "#ff9f43",
  "#a0a8b8",
] as const;

export type Group = {
  id: string;
  name: string;
  /** CSS color for monogram circle. */
  color: string;
};

export type Conversation = {
  id: string;
  name: string;
  groupId: string;
};

export const DEFAULT_GROUP: Group = {
  id: GROUP_DEFAULT_ID,
  name: "Home",
  color: GROUP_COLORS[0],
};

/** Seeded under the default group on empty state. */
export const DEFAULT_CONVERSATIONS: Conversation[] = [
  { id: CONVO_MAIN_ID, name: "Main", groupId: GROUP_DEFAULT_ID },
  { id: CONVO_SCRATCH_ID, name: "Scratch", groupId: GROUP_DEFAULT_ID },
];

/** @deprecated use DEFAULT_CONVERSATIONS */
export const STATIC_CONVERSATIONS = DEFAULT_CONVERSATIONS;

/** Per-conversation UI focus restored on switch. */
export type ConversationFocus = {
  stickySessionId: string | null;
  activeSessionId: string | null;
};

/** Per-group focus: which conversation was last active. */
export type GroupFocus = {
  activeConversationId: string | null;
};

/** Monogram letter for a group name (first alphanumeric, else "?"). */
export function groupMonogram(name: string): string {
  const m = name.trim().match(/[A-Za-z0-9]/);
  return (m?.[0] ?? "?").toUpperCase();
}

export interface SessionInfo {
  id: string;
  name: string;
  status: ProcessStatus;
  cwd: string;
  shell: string;
  shellFlavor: string;
  /** Conversation this session belongs to (UI grouping; PTY is global). */
  conversationId: string;
  lineageId: string;
  parentSessionId: string | null;
  forkedFromMessageId: string | null;
  activity: SessionActivity;
  lastCommand?: string;
  /** True while alternate screen (vim, htop, …) is active. */
  tuiActive?: boolean;
  /** True while the backend is still spawning the PTY. */
  starting?: boolean;
  /** "tmux" | "plain" when known. */
  backend?: string;
}

export interface BackendSessionInfo {
  id: string;
  name: string;
  status: ProcessStatus;
  cwd: string;
  shell: string;
  shellFlavor: string;
  /** "tmux" | "plain" — host-local only; remotes never need tmux. */
  backend?: string;
}

export type MessageRole = "user" | "session";
export type StreamState = "open" | "closed";

export interface ChatMessage {
  id: string;
  sessionId: string;
  /** Conversation this message belongs to (filter on switch). */
  conversationId: string;
  role: MessageRole;
  sessionName?: string;
  body: string;
  createdAt: number;
  parentId: string | null;
  streamState: StreamState;
  /** Correlates user + session messages for one run(). */
  turnId?: string;
  turnStatus?: TurnStatus;
  exitCode?: number;
}

export interface SessionOutputEvent {
  sessionId: string;
  chunk: string;
}

export interface SessionStatusEvent {
  sessionId: string;
  status: ProcessStatus;
}

export interface SessionExitEvent {
  sessionId: string;
  code?: number | null;
}

export interface SessionRemovedEvent {
  sessionId: string;
}

/** From host-local tmux pane_current_command polling. */
export interface SessionActivityEvent {
  sessionId: string;
  activity: SessionActivity;
  command: string;
  cwd: string;
}

export interface RunOutputEvent {
  sessionId: string;
  turnId: string;
  chunk: string;
}

export interface RunFinishedEvent {
  sessionId: string;
  turnId: string;
  code: number;
  cwd: string;
}
