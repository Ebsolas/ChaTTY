/**
 * In-app keybindings (scheme v5).
 *
 * Alt = ChaTTY chrome (works even inside a TUI).
 * Ctrl = guest shell/TUI (not intercepted while xterm focused), except
 *   Ctrl+Alt pane reorg and Ctrl± / Ctrl+Shift± zoom which are host chrome.
 * Super = window manager only (never bound).
 *
 * Override via ~/.config/chatty/keybindings.json
 */

export type ActionId =
  | "toggleTerminal"
  | "openInPane"
  | "replacePaneSession"
  | "closePane"
  | "splitPaneVertical"
  | "splitPaneHorizontal"
  | "focusPaneLeft"
  | "focusPaneRight"
  | "focusPaneUp"
  | "focusPaneDown"
  | "resizePaneLeft"
  | "resizePaneRight"
  | "resizePaneUp"
  | "resizePaneDown"
  | "swapPaneLeft"
  | "swapPaneRight"
  | "swapPaneUp"
  | "swapPaneDown"
  | "movePaneLeft"
  | "movePaneRight"
  | "movePaneUp"
  | "movePaneDown"
  | "focusNextPane"
  | "focusPrevPane"
  | "toggleLeftRails"
  | "toggleSessionsRail"
  | "newSession"
  | "closeSession"
  | "renameSession"
  | "renameItem"
  | "focusComposer"
  | "focusGroups"
  | "focusConversations"
  | "focusSessions"
  | "jumpPalette"
  | "nextSession"
  | "prevSession"
  | "session1"
  | "session2"
  | "session3"
  | "session4"
  | "session5"
  | "session6"
  | "session7"
  | "session8"
  | "session9"
  | "openSessionInNewPane1"
  | "openSessionInNewPane2"
  | "openSessionInNewPane3"
  | "openSessionInNewPane4"
  | "openSessionInNewPane5"
  | "openSessionInNewPane6"
  | "openSessionInNewPane7"
  | "openSessionInNewPane8"
  | "openSessionInNewPane9"
  | "zoomPaneIn"
  | "zoomPaneOut"
  | "zoomPaneReset"
  | "zoomAppIn"
  | "zoomAppOut"
  | "zoomAppReset";

export type KeybindingsMap = Record<ActionId, string>;

export interface KeybindingsConfig {
  $comment?: string;
  bindings: Partial<KeybindingsMap>;
}

/**
 * Actions handled even when focus is inside xterm (Alt-based app chrome).
 * Ctrl chords stay out so shells/TUIs keep Ctrl+C/L/W/… except Ctrl+Alt reorg.
 */
export const TERMINAL_ESCAPE_ACTIONS: ReadonlySet<ActionId> = new Set([
  "jumpPalette",
  "toggleTerminal",
  "focusComposer",
  "newSession",
  "openInPane",
  "replacePaneSession",
  "closePane",
  "toggleLeftRails",
  "toggleSessionsRail",
  "focusPaneLeft",
  "focusPaneRight",
  "focusPaneUp",
  "focusPaneDown",
  "resizePaneLeft",
  "resizePaneRight",
  "resizePaneUp",
  "resizePaneDown",
  "swapPaneLeft",
  "swapPaneRight",
  "swapPaneUp",
  "swapPaneDown",
  "movePaneLeft",
  "movePaneRight",
  "movePaneUp",
  "movePaneDown",
  "splitPaneVertical",
  "splitPaneHorizontal",
  "focusNextPane",
  "focusPrevPane",
  "session1",
  "session2",
  "session3",
  "session4",
  "session5",
  "session6",
  "session7",
  "session8",
  "session9",
  "openSessionInNewPane1",
  "openSessionInNewPane2",
  "openSessionInNewPane3",
  "openSessionInNewPane4",
  "openSessionInNewPane5",
  "openSessionInNewPane6",
  "openSessionInNewPane7",
  "openSessionInNewPane8",
  "openSessionInNewPane9",
  "zoomPaneIn",
  "zoomPaneOut",
  "zoomPaneReset",
  "zoomAppIn",
  "zoomAppOut",
  "zoomAppReset",
  "nextSession",
  "prevSession",
  "focusGroups",
  "focusConversations",
  "focusSessions",
]);

/**
 * Scheme v5: flexible panes — always-new open, replace picker, reorg chords.
 * Avoid common Linux DE bindings: Alt+` , Alt+Tab/F2/F4, Super/*.
 */
export const DEFAULT_BINDINGS: KeybindingsMap = {
  jumpPalette: "Alt+P",
  toggleTerminal: "Alt+T",
  focusComposer: "Alt+C",
  newSession: "Alt+N",
  /** New empty pane + session picker (never auto-fill sticky). */
  openInPane: "Alt+Enter",
  /** Replace focused term pane via session picker. */
  replacePaneSession: "Alt+Shift+Enter",
  closePane: "Alt+Shift+W",
  toggleLeftRails: "Alt+B",
  toggleSessionsRail: "Alt+Shift+S",
  renameSession: "Alt+R",
  renameItem: "Alt+R",
  focusGroups: "Alt+G",
  focusConversations: "Alt+Shift+C",
  focusSessions: "Alt+S",

  focusPaneLeft: "Alt+ArrowLeft",
  focusPaneRight: "Alt+ArrowRight",
  focusPaneUp: "Alt+ArrowUp",
  focusPaneDown: "Alt+ArrowDown",
  resizePaneLeft: "Alt+Shift+ArrowLeft",
  resizePaneRight: "Alt+Shift+ArrowRight",
  resizePaneUp: "Alt+Shift+ArrowUp",
  resizePaneDown: "Alt+Shift+ArrowDown",
  swapPaneLeft: "Ctrl+Alt+ArrowLeft",
  swapPaneRight: "Ctrl+Alt+ArrowRight",
  swapPaneUp: "Ctrl+Alt+ArrowUp",
  swapPaneDown: "Ctrl+Alt+ArrowDown",
  movePaneLeft: "Ctrl+Alt+Shift+ArrowLeft",
  movePaneRight: "Ctrl+Alt+Shift+ArrowRight",
  movePaneUp: "Ctrl+Alt+Shift+ArrowUp",
  movePaneDown: "Ctrl+Alt+Shift+ArrowDown",
  splitPaneVertical: "Alt+Shift+Equal",
  splitPaneHorizontal: "Alt+Shift+Minus",
  focusNextPane: "Alt+O",
  focusPrevPane: "Alt+Shift+O",

  closeSession: "Delete",
  nextSession: "Alt+BracketRight",
  prevSession: "Alt+BracketLeft",
  session1: "Alt+1",
  session2: "Alt+2",
  session3: "Alt+3",
  session4: "Alt+4",
  session5: "Alt+5",
  session6: "Alt+6",
  session7: "Alt+7",
  session8: "Alt+8",
  session9: "Alt+9",
  openSessionInNewPane1: "Alt+Shift+1",
  openSessionInNewPane2: "Alt+Shift+2",
  openSessionInNewPane3: "Alt+Shift+3",
  openSessionInNewPane4: "Alt+Shift+4",
  openSessionInNewPane5: "Alt+Shift+5",
  openSessionInNewPane6: "Alt+Shift+6",
  openSessionInNewPane7: "Alt+Shift+7",
  openSessionInNewPane8: "Alt+Shift+8",
  openSessionInNewPane9: "Alt+Shift+9",
  /** Focused pane only (xterm font / chat scale). */
  zoomPaneIn: "Ctrl+Equal",
  zoomPaneOut: "Ctrl+Minus",
  zoomPaneReset: "Ctrl+0",
  /** Whole ChaTTY UI (CSS zoom on .app). */
  zoomAppIn: "Ctrl+Shift+Equal",
  zoomAppOut: "Ctrl+Shift+Minus",
  zoomAppReset: "Ctrl+Shift+0",
};

export const ACTION_LABELS: Record<ActionId, string> = {
  toggleTerminal: "Toggle focused terminal",
  openInPane: "New workspace pane (pick session)",
  replacePaneSession: "Replace focused pane session",
  closePane: "Close workspace pane (not session)",
  splitPaneVertical: "Split pane side-by-side",
  splitPaneHorizontal: "Split pane stacked",
  focusPaneLeft: "Focus pane left",
  focusPaneRight: "Focus pane right",
  focusPaneUp: "Focus pane up",
  focusPaneDown: "Focus pane down",
  resizePaneLeft: "Resize pane left",
  resizePaneRight: "Resize pane right",
  resizePaneUp: "Resize pane up",
  resizePaneDown: "Resize pane down",
  swapPaneLeft: "Swap pane left",
  swapPaneRight: "Swap pane right",
  swapPaneUp: "Swap pane up",
  swapPaneDown: "Swap pane down",
  movePaneLeft: "Move pane left",
  movePaneRight: "Move pane right",
  movePaneUp: "Move pane up",
  movePaneDown: "Move pane down",
  focusNextPane: "Focus next workspace pane",
  focusPrevPane: "Focus previous workspace pane",
  toggleLeftRails: "Toggle left rails",
  toggleSessionsRail: "Toggle sessions rail",
  newSession: "New item (focused rail)",
  closeSession: "Close session (sessions rail)",
  renameSession: "Rename highlighted item",
  renameItem: "Rename highlighted item",
  focusComposer: "Focus chat pane / composer",
  focusGroups: "Focus groups rail",
  focusConversations: "Focus conversations rail",
  focusSessions: "Focus sessions rail",
  jumpPalette: "Jump / command palette",
  nextSession: "Next session",
  prevSession: "Previous session",
  session1: "Session 1 (focused terminal)",
  session2: "Session 2 (focused terminal)",
  session3: "Session 3 (focused terminal)",
  session4: "Session 4 (focused terminal)",
  session5: "Session 5 (focused terminal)",
  session6: "Session 6 (focused terminal)",
  session7: "Session 7 (focused terminal)",
  session8: "Session 8 (focused terminal)",
  session9: "Session 9 (focused terminal)",
  openSessionInNewPane1: "Open session 1 in new pane",
  openSessionInNewPane2: "Open session 2 in new pane",
  openSessionInNewPane3: "Open session 3 in new pane",
  openSessionInNewPane4: "Open session 4 in new pane",
  openSessionInNewPane5: "Open session 5 in new pane",
  openSessionInNewPane6: "Open session 6 in new pane",
  openSessionInNewPane7: "Open session 7 in new pane",
  openSessionInNewPane8: "Open session 8 in new pane",
  openSessionInNewPane9: "Open session 9 in new pane",
  zoomPaneIn: "Zoom focused pane in",
  zoomPaneOut: "Zoom focused pane out",
  zoomPaneReset: "Reset focused pane zoom",
  zoomAppIn: "Zoom whole app in",
  zoomAppOut: "Zoom whole app out",
  zoomAppReset: "Reset whole app zoom",
};

const ACTION_IDS = Object.keys(DEFAULT_BINDINGS) as ActionId[];

function chordSpecificity(chord: string): number {
  const p = parseChord(chord);
  let n = 0;
  if (p.ctrl) n += 4;
  if (p.alt) n += 4;
  if (p.shift) n += 2;
  if (p.meta) n += 4;
  return n;
}

export function mergeKeybindings(
  partial?: Partial<KeybindingsMap> | null,
): KeybindingsMap {
  const out = { ...DEFAULT_BINDINGS };
  if (!partial) return out;
  for (const id of ACTION_IDS) {
    const v = partial[id];
    if (typeof v === "string" && v.trim()) {
      out[id] = normalizeChord(v);
    }
  }
  return out;
}

export function normalizeChord(raw: string): string {
  const parts = raw
    .split("+")
    .map((p) => p.trim())
    .filter(Boolean);
  if (parts.length === 0) return raw.trim();

  const mods: string[] = [];
  let key = "";
  for (const p of parts) {
    const low = p.toLowerCase();
    if (low === "alt" || low === "option") mods.push("Alt");
    else if (low === "ctrl" || low === "control") mods.push("Ctrl");
    else if (low === "shift") mods.push("Shift");
    else if (low === "meta" || low === "cmd" || low === "super" || low === "win")
      mods.push("Meta");
    else key = canonicalizeKey(p);
  }
  const order = ["Ctrl", "Alt", "Shift", "Meta"];
  mods.sort((a, b) => order.indexOf(a) - order.indexOf(b));
  return [...new Set(mods), key || parts[parts.length - 1]!].join("+");
}

function canonicalizeKey(k: string): string {
  const low = k.toLowerCase();
  const aliases: Record<string, string> = {
    "`": "Backquote",
    backquote: "Backquote",
    backtick: "Backquote",
    "[": "BracketLeft",
    "]": "BracketRight",
    bracketleft: "BracketLeft",
    bracketright: "BracketRight",
    "/": "Slash",
    slash: "Slash",
    " ": "Space",
    space: "Space",
    esc: "Escape",
    escape: "Escape",
    enter: "Enter",
    return: "Enter",
    tab: "Tab",
    "-": "Minus",
    minus: "Minus",
    "=": "Equal",
    equal: "Equal",
    plus: "Equal",
    "+": "Equal",
    arrowleft: "ArrowLeft",
    arrowright: "ArrowRight",
    arrowup: "ArrowUp",
    arrowdown: "ArrowDown",
    left: "ArrowLeft",
    right: "ArrowRight",
    up: "ArrowUp",
    down: "ArrowDown",
    delete: "Delete",
    del: "Delete",
    f2: "F2",
  };
  if (aliases[low]) return aliases[low]!;
  const digit = low.match(/^(?:digit)?([0-9])$/);
  if (digit) return digit[1]!;
  if (/^[a-z]$/i.test(k)) return k.toUpperCase();
  if (/^[A-Z][a-zA-Z0-9]+$/.test(k)) return k;
  return k;
}

export interface ParsedChord {
  alt: boolean;
  ctrl: boolean;
  shift: boolean;
  meta: boolean;
  key: string;
  code?: string;
}

export function parseChord(chord: string): ParsedChord {
  const norm = normalizeChord(chord);
  const parts = norm.split("+");
  const parsed: ParsedChord = {
    alt: false,
    ctrl: false,
    shift: false,
    meta: false,
    key: "",
  };
  for (const p of parts) {
    if (p === "Alt") parsed.alt = true;
    else if (p === "Ctrl") parsed.ctrl = true;
    else if (p === "Shift") parsed.shift = true;
    else if (p === "Meta") parsed.meta = true;
    else {
      parsed.key = p;
      if (/^[0-9]$/.test(p)) parsed.code = `Digit${p}`;
      else if (/^[A-Z]$/.test(p)) parsed.code = `Key${p}`;
      else if (p.startsWith("Arrow")) parsed.code = p;
      else if (p === "F2") parsed.code = "F2";
      else if (p === "Delete") parsed.code = "Delete";
      else if (p === "Minus") parsed.code = "Minus";
      else if (p === "Equal") parsed.code = "Equal";
      else if (p === "Space") parsed.code = "Space";
      else if (
        [
          "Backquote",
          "BracketLeft",
          "BracketRight",
          "Slash",
          "Escape",
          "Enter",
          "Tab",
        ].includes(p)
      ) {
        parsed.code = p;
      }
    }
  }
  return parsed;
}

export function eventMatchesChord(e: KeyboardEvent, chord: string): boolean {
  const p = parseChord(chord);
  if (!!e.altKey !== p.alt) return false;
  if (!!e.ctrlKey !== p.ctrl) return false;
  if (!!e.shiftKey !== p.shift) return false;
  if (!!e.metaKey !== p.meta) return false;

  if (p.code && e.code === p.code) return true;

  const ek = e.key;
  if (!p.key) return false;
  if (p.key === "Backquote") return ek === "`" || e.code === "Backquote";
  if (p.key === "BracketLeft") return ek === "[" || e.code === "BracketLeft";
  if (p.key === "BracketRight") return ek === "]" || e.code === "BracketRight";
  if (p.key === "Slash") return ek === "/" || e.code === "Slash";
  if (p.key === "Minus") return ek === "-" || e.code === "Minus";
  if (p.key === "Equal") return ek === "=" || ek === "+" || e.code === "Equal";
  if (p.key === "Space") return ek === " " || e.code === "Space";
  if (p.key.startsWith("Arrow")) return ek === p.key || e.code === p.key;
  if (p.key === "Delete") return ek === "Delete" || e.code === "Delete";
  if (p.key === "F2") return ek === "F2" || e.code === "F2";
  if (/^[0-9]$/.test(p.key)) return ek === p.key || e.code === `Digit${p.key}`;
  if (/^[A-Z]$/.test(p.key)) return ek.toUpperCase() === p.key;
  return ek === p.key || e.code === p.key;
}

export function matchAction(
  e: KeyboardEvent,
  bindings: KeybindingsMap,
): ActionId | null {
  const ids = [...ACTION_IDS].sort(
    (a, b) => chordSpecificity(bindings[b]) - chordSpecificity(bindings[a]),
  );
  for (const id of ids) {
    if (eventMatchesChord(e, bindings[id])) return id;
  }
  return null;
}

export function formatChordDisplay(chord: string): string {
  const p = parseChord(chord);
  const mods: string[] = [];
  if (p.ctrl) mods.push("Ctrl");
  if (p.alt) mods.push("Alt");
  if (p.shift) mods.push("Shift");
  if (p.meta) mods.push("Meta");
  let key = p.key;
  if (key === "Backquote") key = "`";
  else if (key === "BracketLeft") key = "[";
  else if (key === "BracketRight") key = "]";
  else if (key === "Slash") key = "/";
  else if (key === "Minus") key = "-";
  else if (key === "Equal") key = "=";
  else if (key === "Space") key = "Space";
  else if (key === "ArrowLeft") key = "←";
  else if (key === "ArrowRight") key = "→";
  else if (key === "ArrowUp") key = "↑";
  else if (key === "ArrowDown") key = "↓";
  else if (key.length === 1) key = key.toUpperCase();
  return [...mods, key].join("+");
}

export function sessionIndexAction(index: number): ActionId | null {
  if (index < 0 || index > 8) return null;
  return `session${index + 1}` as ActionId;
}

/** True if the event target is inside an xterm instance (guest PTY). */
export function isXtermTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el?.closest) return false;
  return !!el.closest(".xterm");
}
