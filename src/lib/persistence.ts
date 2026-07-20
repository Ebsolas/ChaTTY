/**
 * Persist conversations + sessions + chat history to ~/.config/chatty/state.json.
 */

import { invoke } from "@tauri-apps/api/core";
import { get } from "svelte/store";
import {
  activeConversationId,
  activeSessionId,
  conversationFocus,
  conversations,
  expandedSessionId,
  messages,
  sessions,
  stickySessionId,
} from "./stores";
import type {
  ChatMessage,
  Conversation,
  ConversationFocus,
} from "./types";
import {
  CONVO_MAIN_ID,
  DEFAULT_CONVERSATIONS,
} from "./types";

export type SavedSession = {
  id: string;
  name: string;
  cwd: string;
  shell: string;
  conversationId?: string;
};

export type AppStateFile = {
  version: number;
  savedAt: number;
  stickySessionId: string | null;
  activeSessionId: string | null;
  expandedSessionId: string | null;
  /** v2+ */
  activeConversationId?: string | null;
  conversations?: Conversation[];
  conversationFocus?: Record<string, ConversationFocus>;
  sessions: SavedSession[];
  messages: ChatMessage[];
};

const MAX_MESSAGES = 500;
const STATE_VERSION = 2;
let saveTimer: ReturnType<typeof setTimeout> | null = null;
let saving = false;
let pendingSave = false;
/** When true, skip autosave so boot/teardown cannot wipe disk with empty stores. */
let persistencePaused = false;

export function pausePersistence() {
  persistencePaused = true;
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
}

export function resumePersistence() {
  persistencePaused = false;
}

export async function loadAppState(): Promise<AppStateFile | null> {
  try {
    const state = await invoke<AppStateFile>("load_app_state");
    if (!state) return null;
    // Treat empty file / no sessions and no convos as "fresh".
    if (!state.sessions?.length && !(state.conversations?.length)) return null;
    return migrateAppState(state);
  } catch (err) {
    console.error("load_app_state failed", err);
    return null;
  }
}

/** Normalize conversations + stamp conversationId on legacy rows. */
export function migrateAppState(raw: AppStateFile): AppStateFile {
  // v2+ keeps user order; empty / v1 seeds Main + Scratch.
  const convos =
    raw.conversations?.length && raw.version >= 2
      ? normalizeConversationList(raw.conversations)
      : [...DEFAULT_CONVERSATIONS];

  const fallbackConvoId = convos[0]?.id ?? CONVO_MAIN_ID;

  const activeConvo =
    (raw.activeConversationId &&
    convos.some((c) => c.id === raw.activeConversationId)
      ? raw.activeConversationId
      : null) ?? fallbackConvoId;

  const sessions: SavedSession[] = (raw.sessions ?? []).map((s) => ({
    ...s,
    conversationId:
      s.conversationId && convos.some((c) => c.id === s.conversationId)
        ? s.conversationId
        : fallbackConvoId,
  }));

  const messages = (raw.messages ?? []).map((m) => {
    const sessionConvo =
      sessions.find((s) => s.id === m.sessionId)?.conversationId ?? fallbackConvoId;
    return {
      ...m,
      conversationId:
        typeof m.conversationId === "string" &&
        convos.some((c) => c.id === m.conversationId)
          ? m.conversationId
          : sessionConvo,
    };
  });

  const focus: Record<string, ConversationFocus> = {
    ...(raw.conversationFocus ?? {}),
  };
  // Seed focus from top-level sticky/active for the active convo if missing.
  if (!focus[activeConvo]) {
    focus[activeConvo] = {
      stickySessionId: raw.stickySessionId ?? null,
      activeSessionId: raw.activeSessionId ?? null,
    };
  }
  for (const c of convos) {
    if (!focus[c.id]) {
      focus[c.id] = { stickySessionId: null, activeSessionId: null };
    }
  }

  return {
    ...raw,
    version: STATE_VERSION,
    conversations: convos,
    activeConversationId: activeConvo,
    conversationFocus: focus,
    sessions,
    messages: messages as ChatMessage[],
  };
}

function normalizeConversationList(list: Conversation[]): Conversation[] {
  const seen = new Set<string>();
  const out: Conversation[] = [];
  for (const c of list) {
    if (!c?.id || !c.name?.trim() || seen.has(c.id)) continue;
    seen.add(c.id);
    out.push({ id: c.id, name: c.name.trim() });
  }
  return out.length ? out : [...DEFAULT_CONVERSATIONS];
}

export function scheduleSaveAppState(delayMs = 800) {
  if (persistencePaused) return;
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    void flushSaveAppState();
  }, delayMs);
}

export async function flushSaveAppState(): Promise<void> {
  if (persistencePaused) return;
  if (saving) {
    pendingSave = true;
    return;
  }
  saving = true;
  try {
    const list = get(sessions);
    const convos = get(conversations);
    // Boot/teardown: don't wipe disk with a fully empty unbooted state.
    // Empty *sessions* are valid (user closed every shell); empty everything is not.
    if (list.length === 0 && convos.length === 0) return;

    let msgs = get(messages);
    if (msgs.length > MAX_MESSAGES) {
      msgs = msgs.slice(msgs.length - MAX_MESSAGES);
    }

    // Snapshot current focus into the map before save.
    const focus = {
      ...get(conversationFocus),
      [get(activeConversationId)]: {
        stickySessionId: get(stickySessionId),
        activeSessionId: get(activeSessionId),
      },
    };

    const payload: AppStateFile = {
      version: STATE_VERSION,
      savedAt: Date.now(),
      stickySessionId: get(stickySessionId),
      activeSessionId: get(activeSessionId),
      expandedSessionId: get(expandedSessionId),
      activeConversationId: get(activeConversationId) || null,
      conversations: convos,
      conversationFocus: focus,
      sessions: list.map((s) => ({
        id: s.id,
        name: s.name,
        cwd: s.cwd ?? "",
        shell: s.shell ?? "",
        conversationId: s.conversationId ?? CONVO_MAIN_ID,
      })),
      messages: msgs.map((m) => ({
        ...m,
        conversationId: m.conversationId ?? CONVO_MAIN_ID,
        streamState: "closed" as const,
        turnStatus:
          m.turnStatus === "running" ? ("ok" as const) : m.turnStatus,
      })),
    };

    await invoke<string>("save_app_state", { state: payload });
  } catch (err) {
    console.error("save_app_state failed", err);
  } finally {
    saving = false;
    if (pendingSave && !persistencePaused) {
      pendingSave = false;
      void flushSaveAppState();
    } else {
      pendingSave = false;
    }
  }
}

/** Normalize messages loaded from disk for the store. */
export function normalizeLoadedMessages(raw: unknown[]): ChatMessage[] {
  const out: ChatMessage[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const m = item as Partial<ChatMessage>;
    if (!m.id || !m.sessionId || !m.role || typeof m.body !== "string") continue;
    out.push({
      id: m.id,
      sessionId: m.sessionId,
      conversationId:
        typeof m.conversationId === "string" && m.conversationId
          ? m.conversationId
          : CONVO_MAIN_ID,
      role: m.role === "user" ? "user" : "session",
      sessionName: m.sessionName,
      body: m.body,
      createdAt: typeof m.createdAt === "number" ? m.createdAt : Date.now(),
      parentId: m.parentId ?? null,
      streamState: "closed",
      turnId: m.turnId,
      turnStatus:
        m.turnStatus === "running" ? "ok" : (m.turnStatus as ChatMessage["turnStatus"]),
      exitCode: m.exitCode,
    });
  }
  return out;
}

export { CONVO_MAIN_ID, DEFAULT_CONVERSATIONS };
