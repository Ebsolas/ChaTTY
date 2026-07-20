/**
 * Detect full-screen / TUI mode from PTY stream (alternate screen buffer).
 * Common private modes: 47, 1047, 1049 (smcup/rmcup).
 *
 * Sequences can be split across PTY read chunks — keep a short carry buffer.
 */

/** CSI private mode: ESC [ ? <nums> h|l  e.g. \x1b[?1049h or \x1b[?1;1049h */
const PRIVATE_MODE_RE = /\x1b\[\?([0-9;]+)([hl])/g;

const ALT_SCREEN_MODES = new Set([47, 1047, 1049]);

/** Incomplete ESC sequences at end of a chunk (max CSI length we care about). */
const CARRY_MAX = 64;

export type AltScreenDelta = "enter" | "leave" | null;

/**
 * Per-session carry for CSI fragments split across reads.
 * Call `scanAltScreen(sessionId, chunk)` instead of raw detect.
 */
const carryBySession = new Map<string, string>();

export function resetAltScreenCarry(sessionId?: string) {
  if (sessionId) carryBySession.delete(sessionId);
  else carryBySession.clear();
}

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

/**
 * Session-aware scan that reunites CSI sequences split across chunks.
 * Only an explicit leave CSI clears TUI; incomplete tails are held back.
 */
export function scanAltScreen(sessionId: string, chunk: string): AltScreenDelta {
  const carry = carryBySession.get(sessionId) ?? "";
  const combined = carry + chunk;

  // Hold a trailing incomplete ESC… sequence for the next chunk.
  let stable = combined;
  const esc = combined.lastIndexOf("\x1b");
  if (esc >= 0) {
    const tail = combined.slice(esc);
    // Complete private mode ends with h/l; other complete CSI ends with a final byte 0x40–0x7E
    const completePrivate = /^\x1b\[\?[0-9;]*[hl]$/.test(tail);
    const completeOtherCsi = /^\x1b\[[0-9;?]*[\x40-\x7e]$/.test(tail);
    const completeEsc = /^\x1b[^[]$/.test(tail) || /^\x1b.$/.test(tail);
    if (!completePrivate && !completeOtherCsi && !completeEsc && tail.length < CARRY_MAX) {
      stable = combined.slice(0, esc);
      carryBySession.set(sessionId, tail);
    } else {
      carryBySession.set(sessionId, "");
    }
  } else {
    carryBySession.set(sessionId, "");
  }

  if (!stable) return null;
  return detectAltScreenChange(stable);
}

/** True if chunk looks like heavy TUI redraw noise (cursor spam / clears). */
export function looksLikeTuiNoise(chunk: string): boolean {
  const cup = (chunk.match(/\x1b\[[0-9;]*H/g) || []).length;
  const ed = (chunk.match(/\x1b\[[0-9]*J/g) || []).length;
  const cup2 = (chunk.match(/\x1b\[[0-9;]*f/g) || []).length;
  return cup + cup2 + ed >= 6 && chunk.length > 120;
}
