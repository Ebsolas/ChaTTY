/**
 * Collapsible app chrome (rails). Independent of work-surface panes.
 * Persisted in localStorage for snappy restore.
 */

import { writable } from "svelte/store";

const KEY = "chatty.chromeLayout";

export type ChromeLayout = {
  leftRailsVisible: boolean;
  sessionsRailVisible: boolean;
};

const DEFAULTS: ChromeLayout = {
  leftRailsVisible: true,
  sessionsRailVisible: true,
};

function load(): ChromeLayout {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { ...DEFAULTS };
    const p = JSON.parse(raw) as Partial<ChromeLayout>;
    return {
      leftRailsVisible: p.leftRailsVisible !== false,
      sessionsRailVisible: p.sessionsRailVisible !== false,
    };
  } catch {
    return { ...DEFAULTS };
  }
}

function persist(c: ChromeLayout) {
  try {
    localStorage.setItem(KEY, JSON.stringify(c));
  } catch {
    /* ignore */
  }
}

export const chromeLayout = writable<ChromeLayout>(load());

chromeLayout.subscribe((c) => persist(c));

export function setLeftRailsVisible(visible: boolean) {
  chromeLayout.update((c) => ({ ...c, leftRailsVisible: visible }));
}

export function setSessionsRailVisible(visible: boolean) {
  chromeLayout.update((c) => ({ ...c, sessionsRailVisible: visible }));
}

export function toggleLeftRails() {
  chromeLayout.update((c) => ({
    ...c,
    leftRailsVisible: !c.leftRailsVisible,
  }));
}

export function toggleSessionsRail() {
  chromeLayout.update((c) => ({
    ...c,
    sessionsRailVisible: !c.sessionsRailVisible,
  }));
}
