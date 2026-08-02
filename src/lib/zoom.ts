/**
 * App-wide UI zoom (CSS zoom on .app) and per-pane zoom (terminals + chat).
 */

import { get, writable } from "svelte/store";

const APP_KEY = "chatty.uiZoom";
const PANE_KEY = "chatty.paneZoom.v1";

export const APP_ZOOM_MIN = 0.75;
export const APP_ZOOM_MAX = 1.5;
export const APP_ZOOM_STEP = 0.1;
export const APP_ZOOM_DEFAULT = 1;

/** Multiplier on base terminal font / chat content scale. */
export const PANE_ZOOM_MIN = 0.6;
export const PANE_ZOOM_MAX = 2.5;
export const PANE_ZOOM_STEP = 0.1;
export const PANE_ZOOM_DEFAULT = 1;

export const BASE_TERM_FONT_PX = 14;

function clampApp(n: number) {
  return Math.min(
    APP_ZOOM_MAX,
    Math.max(APP_ZOOM_MIN, Math.round(n * 100) / 100),
  );
}

function clampPane(n: number) {
  return Math.min(
    PANE_ZOOM_MAX,
    Math.max(PANE_ZOOM_MIN, Math.round(n * 100) / 100),
  );
}

function loadAppZoom(): number {
  try {
    const raw = localStorage.getItem(APP_KEY);
    if (!raw) return APP_ZOOM_DEFAULT;
    const n = Number(raw);
    if (!Number.isFinite(n)) return APP_ZOOM_DEFAULT;
    return clampApp(n);
  } catch {
    return APP_ZOOM_DEFAULT;
  }
}

function loadPaneZooms(): Record<string, number> {
  try {
    const raw = localStorage.getItem(PANE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object") return {};
    const out: Record<string, number> = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof v === "number" && Number.isFinite(v)) out[k] = clampPane(v);
    }
    return out;
  } catch {
    return {};
  }
}

function persistApp(z: number) {
  try {
    localStorage.setItem(APP_KEY, String(z));
  } catch {
    /* ignore */
  }
}

function persistPanes(map: Record<string, number>) {
  try {
    localStorage.setItem(PANE_KEY, JSON.stringify(map));
  } catch {
    /* ignore */
  }
}

export const appZoom = writable(loadAppZoom());
export const paneZooms = writable<Record<string, number>>(loadPaneZooms());

export function applyAppZoomCss(z: number = get(appZoom)) {
  if (typeof document === "undefined") return;
  const root = document.querySelector(".app") as HTMLElement | null;
  if (root) root.style.zoom = String(z);
}

export function setAppZoom(n: number) {
  const z = clampApp(n);
  appZoom.set(z);
  persistApp(z);
  applyAppZoomCss(z);
}

export function nudgeAppZoom(delta: number) {
  setAppZoom(get(appZoom) + delta);
}

export function resetAppZoom() {
  setAppZoom(APP_ZOOM_DEFAULT);
}

export function chatZoomKey() {
  return "chat";
}

export function sessionZoomKey(sessionId: string) {
  return `session:${sessionId}`;
}

/** Workspace term leaf: zoom follows the pane id (independent per leaf). */
export function paneZoomKey(paneId: string) {
  return `pane:${paneId}`;
}

export function getPaneZoom(key: string): number {
  return get(paneZooms)[key] ?? PANE_ZOOM_DEFAULT;
}

export function setPaneZoom(key: string, n: number) {
  const z = clampPane(n);
  paneZooms.update((m) => {
    const next = { ...m, [key]: z };
    persistPanes(next);
    return next;
  });
}

export function nudgePaneZoom(key: string, delta: number) {
  setPaneZoom(key, getPaneZoom(key) + delta);
}

export function resetPaneZoom(key: string) {
  setPaneZoom(key, PANE_ZOOM_DEFAULT);
}

export function termFontPx(zoom: number): number {
  return Math.max(8, Math.round(BASE_TERM_FONT_PX * zoom));
}
