/**
 * Persisted resizable rail widths (px). Used as CSS vars on .app.
 */

import { writable } from "svelte/store";

const browser = typeof localStorage !== "undefined";

export type RailWidths = {
  groups: number;
  convos: number;
  sessions: number;
};

const STORAGE_KEY = "chatty.railWidths";

export const RAIL_LIMITS = {
  groups: { min: 48, max: 88, default: 52 },
  convos: { min: 140, max: 420, default: 200 },
  sessions: { min: 160, max: 440, default: 240 },
} as const;

function clamp(n: number, min: number, max: number) {
  return Math.max(min, Math.min(max, Math.round(n)));
}

function load(): RailWidths {
  const d = {
    groups: RAIL_LIMITS.groups.default,
    convos: RAIL_LIMITS.convos.default,
    sessions: RAIL_LIMITS.sessions.default,
  };
  if (!browser) return d;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return d;
    const parsed = JSON.parse(raw) as Partial<RailWidths>;
    return {
      groups: clamp(
        Number(parsed.groups) || d.groups,
        RAIL_LIMITS.groups.min,
        RAIL_LIMITS.groups.max,
      ),
      convos: clamp(
        Number(parsed.convos) || d.convos,
        RAIL_LIMITS.convos.min,
        RAIL_LIMITS.convos.max,
      ),
      sessions: clamp(
        Number(parsed.sessions) || d.sessions,
        RAIL_LIMITS.sessions.min,
        RAIL_LIMITS.sessions.max,
      ),
    };
  } catch {
    return d;
  }
}

export const railWidths = writable<RailWidths>(load());

export function setRailWidth(key: keyof RailWidths, px: number) {
  const lim = RAIL_LIMITS[key];
  const next = clamp(px, lim.min, lim.max);
  railWidths.update((w) => {
    const out = { ...w, [key]: next };
    if (browser) {
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(out));
      } catch {
        /* ignore */
      }
    }
    return out;
  });
}

export function railWidthsStyle(w: RailWidths): string {
  return [
    `--w-groups:${w.groups}px`,
    `--w-convos:${w.convos}px`,
    `--w-sessions:${w.sessions}px`,
  ].join(";");
}
