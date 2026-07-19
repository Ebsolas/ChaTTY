/** Domain types — shell-agnostic session service + fork-ready fields. */

export type ProcessStatus = "running" | "exited";
/** idle = at prompt; busy = line command in flight; tui = full-screen app */
export type SessionActivity = "idle" | "busy" | "tui";
export type TurnStatus = "running" | "ok" | "error" | "tui";

export interface SessionInfo {
  id: string;
  name: string;
  status: ProcessStatus;
  cwd: string;
  shell: string;
  shellFlavor: string;
  lineageId: string;
  parentSessionId: string | null;
  forkedFromMessageId: string | null;
  activity: SessionActivity;
  lastCommand?: string;
  /** True while alternate screen (vim, htop, …) is active. */
  tuiActive?: boolean;
}

export interface BackendSessionInfo {
  id: string;
  name: string;
  status: ProcessStatus;
  cwd: string;
  shell: string;
  shellFlavor: string;
}

export type MessageRole = "user" | "session";
export type StreamState = "open" | "closed";

export interface ChatMessage {
  id: string;
  sessionId: string;
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
