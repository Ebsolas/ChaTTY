/**
 * Keyboard focus regions for multi-rail navigation.
 * Tab cycles rails; j/k and arrows move selection inside the focused rail.
 */

import { get, writable } from "svelte/store";

export type FocusRegion =
  | "groups"
  | "conversations"
  | "sessions"
  | "composer"
  | "terminal"
  | "palette";

/** Rails that participate in Tab cycling (not terminal/palette). */
export const TAB_REGIONS: FocusRegion[] = [
  "groups",
  "conversations",
  "sessions",
  "composer",
];

export const focusRegion = writable<FocusRegion>("composer");

/** Highlight (keyboard selection) — may differ from active until Enter. */
export const selectedGroupId = writable<string | null>(null);
export const selectedConversationId = writable<string | null>(null);
export const selectedSessionId = writable<string | null>(null);

export const jumpPaletteOpen = writable(false);

/** True while an inline rename input should own keys. */
export const renameActive = writable(false);

/**
 * Focus a region. Only the rail shell / composer input receive DOM focus —
 * never pencils, + buttons, or list rows (those use visual selection + j/k).
 */
export function setFocusRegion(region: FocusRegion) {
  focusRegion.set(region);
  queueMicrotask(() => {
    if (region === "composer") {
      document
        .querySelector<HTMLInputElement>("[data-composer-input]")
        ?.focus({ preventScroll: true });
      return;
    }
    if (region === "palette") {
      document
        .querySelector<HTMLInputElement>("[data-jump-palette-input]")
        ?.focus({ preventScroll: true });
      return;
    }
    // Prefer the rail host itself (not nested option buttons).
    const el = document.querySelector<HTMLElement>(
      `aside[data-focus-region="${region}"]`,
    );
    el?.focus({ preventScroll: true });
  });
}

export function cycleFocusRegion(delta: 1 | -1) {
  const cur = get(focusRegion);
  const list = TAB_REGIONS;
  let idx = list.indexOf(cur as (typeof list)[number]);
  if (idx < 0) idx = delta > 0 ? -1 : 0;
  const next = list[(idx + delta + list.length * 10) % list.length]!;
  setFocusRegion(next);
}

export function isTypingContext(target: EventTarget | null): boolean {
  const t = target as HTMLElement | null;
  if (!t) return false;
  if (t.isContentEditable) return true;
  const tag = t.tagName?.toLowerCase();
  if (tag === "textarea") return true;
  if (tag === "input") {
    const type = (t as HTMLInputElement).type?.toLowerCase() ?? "text";
    if (["button", "checkbox", "radio", "submit", "reset", "file"].includes(type)) {
      return false;
    }
    return true;
  }
  // xterm textarea
  if (t.closest?.(".xterm")) return true;
  return false;
}

export function isRenameInput(target: EventTarget | null): boolean {
  const t = target as HTMLElement | null;
  return !!t?.classList?.contains("rename-input");
}
