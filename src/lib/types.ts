/** Domain types — shell-agnostic session service + fork-ready fields. */

export type ProcessStatus = "starting" | "running" | "exited";
/** idle = at prompt; busy = line command in flight; tui = full-screen app */
export type SessionActivity = "idle" | "busy" | "tui";
export type TurnStatus = "running" | "ok" | "error" | "tui";

/** Default conversation ids for first boot / v1 migration. */
export const CONVO_MAIN_ID = "convo-main";
export const CONVO_SCRATCH_ID = "convo-scratch";

export type Conversation = {
  id: string;
  name: string;
};

/** Seeded on empty state; users can rename/delete/reorder freely after. */
export const DEFAULT_CONVERSATIONS: Conversation[] = [
  { id: CONVO_MAIN_ID, name: "Main" },
  { id: CONVO_SCRATCH_ID, name: "Scratch" },
];

/** @deprecated use DEFAULT_CONVERSATIONS */
export const STATIC_CONVERSATIONS = DEFAULT_CONVERSATIONS;

/** Per-conversation UI focus restored on switch. */
export type ConversationFocus = {
  stickySessionId: string | null;
  activeSessionId: string | null;
};

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
