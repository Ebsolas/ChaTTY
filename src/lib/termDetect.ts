/**
 * Detect full-screen / TUI mode from PTY stream (alternate screen buffer).
 * Common private modes: 47, 1047, 1049 (smcup/rmcup).
 */

/** CSI private mode: ESC [ ? <nums> h|l  e.g. \x1b[?1049h or \x1b[?1;1049h */
const PRIVATE_MODE_RE = /\x1b\[\?([0-9;]+)([hl])/g;

const ALT_SCREEN_MODES = new Set([47, 1047, 1049]);

export type AltScreenDelta = "enter" | "leave" | null;

/**
 * Scan a PTY chunk for alternate-screen enter/leave.
 * If both appear in one chunk, the last one wins.
 */
export function detectAltScreenChange(chunk: string): AltScreenDelta {
  let last: AltScreenDelta = null;
  PRIVATE_MODE_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = PRIVATE_MODE_RE.exec(chunk)) !== null) {
    const modes = m[1]!.split(";").map((n) => Number(n));
    const isAlt = modes.some((n) => ALT_SCREEN_MODES.has(n));
    if (!isAlt) continue;
    last = m[2] === "h" ? "enter" : "leave";
  }
  return last;
}

/** True if chunk looks like heavy TUI redraw noise (optional heuristic). */
export function looksLikeTuiNoise(chunk: string): boolean {
  // Dense cursor addressing / erase without alt-screen still happens in some apps
  const cup = (chunk.match(/\x1b\[[0-9;]*H/g) || []).length;
  const ed = (chunk.match(/\x1b\[[0-9]*J/g) || []).length;
  return cup + ed >= 8 && chunk.length > 200;
}
