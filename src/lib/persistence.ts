/**
 * Persist sessions + chat history to ~/.config/chatty/state.json via Tauri.
 */

import { invoke } from "@tauri-apps/api/core";
import { get } from "svelte/store";
import {
  activeSessionId,
  expandedSessionId,
  messages,
  sessions,
  stickySessionId,
} from "./stores";
import type { ChatMessage } from "./types";

export type SavedSession = {
  id: string;
  name: string;
  cwd: string;
  shell: string;
};

export type AppStateFile = {
  version: number;
  savedAt: number;
  stickySessionId: string | null;
  activeSessionId: string | null;
  /** Session terminal overlay open at last save, if any. */
  expandedSessionId: string | null;
  sessions: SavedSession[];
  messages: ChatMessage[];
};

const MAX_MESSAGES = 500;
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
    if (!state?.sessions?.length) return null;
    return state;
  } catch (err) {
    console.error("load_app_state failed", err);
    return null;
  }
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
    // Never overwrite a good save with an empty in-memory list (boot/teardown race).
    if (list.length === 0) return;

    let msgs = get(messages);
    if (msgs.length > MAX_MESSAGES) {
      msgs = msgs.slice(msgs.length - MAX_MESSAGES);
    }
    const payload: AppStateFile = {
      version: 1,
      savedAt: Date.now(),
      stickySessionId: get(stickySessionId),
      activeSessionId: get(activeSessionId),
      expandedSessionId: get(expandedSessionId),
      sessions: list.map((s) => ({
        id: s.id,
        name: s.name,
        cwd: s.cwd ?? "",
        shell: s.shell ?? "",
      })),
      messages: msgs.map((m) => ({
        ...m,
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
