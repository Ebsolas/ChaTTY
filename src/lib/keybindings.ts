/**
 * In-app keybindings. Defaults use Alt as the navigation modifier.
 * Override via ~/.config/chatty/keybindings.json (see config/keybindings.example.json).
 */

export type ActionId =
  | "toggleTerminal"
  | "newSession"
  | "closeSession"
  | "renameSession"
  | "focusComposer"
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
  | "session9";

export type KeybindingsMap = Record<ActionId, string>;

export interface KeybindingsConfig {
  /** Optional comment field ignored by the loader. */
  $comment?: string;
  bindings: Partial<KeybindingsMap>;
}

/** Canonical defaults — Alt for navigation. */
export const DEFAULT_BINDINGS: KeybindingsMap = {
  toggleTerminal: "Alt+Backquote",
  newSession: "Alt+N",
  closeSession: "Alt+W",
  renameSession: "Alt+R",
  focusComposer: "Alt+C",
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
};

export const ACTION_LABELS: Record<ActionId, string> = {
  toggleTerminal: "Toggle session terminal",
  newSession: "New session",
  closeSession: "Close session",
  renameSession: "Rename session",
  focusComposer: "Focus composer",
  nextSession: "Next session",
  prevSession: "Previous session",
  session1: "Session 1",
  session2: "Session 2",
  session3: "Session 3",
  session4: "Session 4",
  session5: "Session 5",
  session6: "Session 6",
  session7: "Session 7",
  session8: "Session 8",
  session9: "Session 9",
};

const ACTION_IDS = Object.keys(DEFAULT_BINDINGS) as ActionId[];

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

/** Normalize user-facing chords to a stable form. */
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
  // Stable mod order
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
  };
  if (aliases[low]) return aliases[low]!;
  // Digit1 / 1 / Digit 1
  const digit = low.match(/^(?:digit)?([0-9])$/);
  if (digit) return digit[1]!;
  // Single letter
  if (/^[a-z]$/i.test(k)) return k.toUpperCase();
  // Already a KeyboardEvent.code-like token
  if (/^[A-Z][a-zA-Z0-9]+$/.test(k)) return k;
  return k;
}

export interface ParsedChord {
  alt: boolean;
  ctrl: boolean;
  shift: boolean;
  meta: boolean;
  /** Match against event.key (case-insensitive for letters) or event.code */
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
      // Map to event.code when possible
      if (/^[0-9]$/.test(p)) parsed.code = `Digit${p}`;
      else if (/^[A-Z]$/.test(p)) parsed.code = `Key${p}`;
      else if (
        [
          "Backquote",
          "BracketLeft",
          "BracketRight",
          "Slash",
          "Space",
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

  // Fallback: key matching
  const ek = e.key;
  if (!p.key) return false;
  if (p.key === "Backquote") return ek === "`" || e.code === "Backquote";
  if (p.key === "BracketLeft") return ek === "[" || e.code === "BracketLeft";
  if (p.key === "BracketRight") return ek === "]" || e.code === "BracketRight";
  if (p.key === "Slash") return ek === "/" || e.code === "Slash";
  if (/^[0-9]$/.test(p.key)) return ek === p.key || e.code === `Digit${p.key}`;
  if (/^[A-Z]$/.test(p.key)) return ek.toUpperCase() === p.key;
  return ek === p.key || e.code === p.key;
}

/** Resolve which action (if any) a keydown maps to. First match wins. */
export function matchAction(
  e: KeyboardEvent,
  bindings: KeybindingsMap,
): ActionId | null {
  // Prefer longer / more specific by checking in a stable order
  for (const id of ACTION_IDS) {
    if (eventMatchesChord(e, bindings[id])) return id;
  }
  return null;
}

/** Short label for UI chips, e.g. Alt+` */
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
  else if (key.length === 1) key = key.toUpperCase();
  return [...mods, key].join("+");
}

export function sessionIndexAction(index: number): ActionId | null {
  if (index < 0 || index > 8) return null;
  return `session${index + 1}` as ActionId;
}
