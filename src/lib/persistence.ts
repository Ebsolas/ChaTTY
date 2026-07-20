/**
 * Persist groups + conversations + sessions + chat to ~/.config/chatty/state.json.
 */

import { invoke } from "@tauri-apps/api/core";
import { get } from "svelte/store";
import {
  activeConversationId,
  activeGroupId,
  activeSessionId,
  conversationFocus,
  conversations,
  expandedSessionId,
  groupFocus,
  groups,
  messages,
  sessions,
  stickySessionId,
} from "./stores";
import type {
  ChatMessage,
  Conversation,
  ConversationFocus,
  Group,
  GroupFocus,
} from "./types";
import {
  CONVO_MAIN_ID,
  DEFAULT_CONVERSATIONS,
  DEFAULT_GROUP,
  GROUP_COLORS,
  GROUP_DEFAULT_ID,
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
  activeConversationId?: string | null;
  activeGroupId?: string | null;
  groups?: Group[];
  groupFocus?: Record<string, GroupFocus>;
  conversations?: Conversation[];
  conversationFocus?: Record<string, ConversationFocus>;
  sessions: SavedSession[];
  messages: ChatMessage[];
};

const MAX_MESSAGES = 500;
const STATE_VERSION = 3;
let saveTimer: ReturnType<typeof setTimeout> | null = null;
let saving = false;
let pendingSave = false;
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
    if (
      !state.sessions?.length &&
      !(state.conversations?.length) &&
      !(state.groups?.length)
    ) {
      return null;
    }
    return migrateAppState(state);
  } catch (err) {
    console.error("load_app_state failed", err);
    return null;
  }
}

/** Normalize groups/conversations; migrate v1/v2 → v3. */
export function migrateAppState(raw: AppStateFile): AppStateFile {
  let groupList: Group[];
  if (raw.groups?.length && raw.version >= 3) {
    groupList = normalizeGroupList(raw.groups);
  } else {
    groupList = [{ ...DEFAULT_GROUP }];
  }

  const fallbackGroupId = groupList[0]?.id ?? GROUP_DEFAULT_ID;

  let convos: Conversation[];
  if (raw.conversations?.length && raw.version >= 2) {
    convos = normalizeConversationList(raw.conversations, fallbackGroupId, groupList);
  } else {
    convos = DEFAULT_CONVERSATIONS.map((c) => ({
      ...c,
      groupId: fallbackGroupId,
    }));
  }

  // Ensure every groupId on a convo exists.
  const groupIds = new Set(groupList.map((g) => g.id));
  convos = convos.map((c) =>
    groupIds.has(c.groupId) ? c : { ...c, groupId: fallbackGroupId },
  );

  const fallbackConvoId = convos[0]?.id ?? CONVO_MAIN_ID;

  const activeGroup =
    (raw.activeGroupId && groupIds.has(raw.activeGroupId)
      ? raw.activeGroupId
      : null) ?? fallbackGroupId;

  const activeConvo =
    (raw.activeConversationId &&
    convos.some((c) => c.id === raw.activeConversationId)
      ? raw.activeConversationId
      : null) ??
    convos.find((c) => c.groupId === activeGroup)?.id ??
    fallbackConvoId;

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

  const cFocus: Record<string, ConversationFocus> = {
    ...(raw.conversationFocus ?? {}),
  };
  if (!cFocus[activeConvo]) {
    cFocus[activeConvo] = {
      stickySessionId: raw.stickySessionId ?? null,
      activeSessionId: raw.activeSessionId ?? null,
    };
  }
  for (const c of convos) {
    if (!cFocus[c.id]) {
      cFocus[c.id] = { stickySessionId: null, activeSessionId: null };
    }
  }

  const gFocus: Record<string, GroupFocus> = {
    ...(raw.groupFocus ?? {}),
  };
  if (!gFocus[activeGroup]) {
    gFocus[activeGroup] = { activeConversationId: activeConvo };
  }
  for (const g of groupList) {
    if (!gFocus[g.id]) {
      gFocus[g.id] = {
        activeConversationId:
          convos.find((c) => c.groupId === g.id)?.id ?? null,
      };
    }
  }

  return {
    ...raw,
    version: STATE_VERSION,
    groups: groupList,
    activeGroupId: activeGroup,
    groupFocus: gFocus,
    conversations: convos,
    activeConversationId: activeConvo,
    conversationFocus: cFocus,
    sessions,
    messages: messages as ChatMessage[],
  };
}

function normalizeGroupList(list: Group[]): Group[] {
  const seen = new Set<string>();
  const out: Group[] = [];
  let colorIdx = 0;
  for (const g of list) {
    if (!g?.id || !g.name?.trim() || seen.has(g.id)) continue;
    seen.add(g.id);
    out.push({
      id: g.id,
      name: g.name.trim(),
      color:
        typeof g.color === "string" && g.color.trim()
          ? g.color.trim()
          : GROUP_COLORS[colorIdx++ % GROUP_COLORS.length]!,
    });
  }
  return out.length ? out : [{ ...DEFAULT_GROUP }];
}

function normalizeConversationList(
  list: Conversation[],
  fallbackGroupId: string,
  groupList: Group[],
): Conversation[] {
  const groupIds = new Set(groupList.map((g) => g.id));
  const seen = new Set<string>();
  const out: Conversation[] = [];
  for (const c of list) {
    if (!c?.id || !c.name?.trim() || seen.has(c.id)) continue;
    seen.add(c.id);
    const gid =
      typeof c.groupId === "string" && groupIds.has(c.groupId)
        ? c.groupId
        : fallbackGroupId;
    out.push({ id: c.id, name: c.name.trim(), groupId: gid });
  }
  return out.length
    ? out
    : DEFAULT_CONVERSATIONS.map((c) => ({ ...c, groupId: fallbackGroupId }));
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
    const groupList = get(groups);
    if (list.length === 0 && convos.length === 0 && groupList.length === 0) return;

    let msgs = get(messages);
    if (msgs.length > MAX_MESSAGES) {
      msgs = msgs.slice(msgs.length - MAX_MESSAGES);
    }

    const focus = {
      ...get(conversationFocus),
      ...(get(activeConversationId)
        ? {
            [get(activeConversationId)]: {
              stickySessionId: get(stickySessionId),
              activeSessionId: get(activeSessionId),
            },
          }
        : {}),
    };

    const gFocus = {
      ...get(groupFocus),
      ...(get(activeGroupId)
        ? {
            [get(activeGroupId)]: {
              activeConversationId: get(activeConversationId) || null,
            },
          }
        : {}),
    };

    const payload: AppStateFile = {
      version: STATE_VERSION,
      savedAt: Date.now(),
      stickySessionId: get(stickySessionId),
      activeSessionId: get(activeSessionId),
      expandedSessionId: get(expandedSessionId),
      activeConversationId: get(activeConversationId) || null,
      activeGroupId: get(activeGroupId) || null,
      groups: groupList,
      groupFocus: gFocus,
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

export { CONVO_MAIN_ID, DEFAULT_CONVERSATIONS, DEFAULT_GROUP, GROUP_DEFAULT_ID };
