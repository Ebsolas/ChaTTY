import type { SessionInfo } from "./types";

export type ParsedComposer = {
  /** Sessions this command should run on (at least one). */
  targets: SessionInfo[];
  /** Command text with @mentions removed. */
  command: string;
  /** If the user only typed @name(s) with no command, switch sticky target. */
  stickyOnly: boolean;
  /** Display label for the user bubble, e.g. "@local ls". */
  display: string;
};

/**
 * Parse Discord-style session mentions.
 *
 *   @local whoami
 *   @local, @other ls -la
 *   whoami                    (uses sticky / active session)
 *   @local                    (switch sticky, no run)
 */
export function parseComposer(
  text: string,
  sessions: SessionInfo[],
  stickyOrActiveId: string | null,
): ParsedComposer {
  const trimmed = text.replace(/\s+$/, "").trim();
  if (!trimmed) {
    return { targets: [], command: "", stickyOnly: true, display: "" };
  }

  // Leading @mentions: @name or @name, @name2
  const mentionRe = /^@([\w.-]+)\s*(?:,\s*)?/i;
  let rest = trimmed;
  const names: string[] = [];

  while (true) {
    const m = rest.match(mentionRe);
    if (!m) break;
    names.push(m[1]!.toLowerCase());
    rest = rest.slice(m[0].length);
  }

  rest = rest.replace(/^\s+/, "");

  const byName = new Map(sessions.map((s) => [s.name.toLowerCase(), s]));
  const targets: SessionInfo[] = [];
  const missing: string[] = [];

  for (const n of names) {
    const s = byName.get(n);
    if (s) {
      if (!targets.some((t) => t.id === s.id)) targets.push(s);
    } else {
      missing.push(n);
    }
  }

  if (missing.length) {
    throw new Error(`Unknown session: ${missing.map((n) => `@${n}`).join(", ")}`);
  }

  if (targets.length === 0) {
    // No mentions — sticky / active session
    const fallback =
      sessions.find((s) => s.id === stickyOrActiveId) ?? sessions[0];
    if (!fallback) {
      throw new Error("No sessions available");
    }
    targets.push(fallback);
  }

  if (!rest) {
    return {
      targets,
      command: "",
      stickyOnly: true,
      display: targets.map((t) => `@${t.name}`).join(", "),
    };
  }

  const mentionPrefix =
    names.length > 0 ? `${targets.map((t) => `@${t.name}`).join(", ")} ` : "";

  return {
    targets,
    command: rest,
    stickyOnly: false,
    display: `${mentionPrefix}${rest}`,
  };
}

/** Session names for autocomplete after typing @ */
export function mentionSuggestions(
  partial: string,
  sessions: SessionInfo[],
): SessionInfo[] {
  const q = partial.replace(/^@/, "").toLowerCase();
  return sessions.filter(
    (s) => !q || s.name.toLowerCase().startsWith(q) || s.name.toLowerCase().includes(q),
  );
}

/**
 * Leading @mentions only (no sticky fallback).
 * Used for Ctrl+C routing: `@local-2` + Ctrl+C interrupts local-2, not sticky.
 */
export function parseLeadingMentions(
  text: string,
  sessions: SessionInfo[],
): { targets: SessionInfo[]; missing: string[] } {
  const trimmed = text.replace(/\s+$/, "").trim();
  if (!trimmed) return { targets: [], missing: [] };

  const mentionRe = /^@([\w.-]+)\s*(?:,\s*)?/i;
  let rest = trimmed;
  const names: string[] = [];

  while (true) {
    const m = rest.match(mentionRe);
    if (!m) break;
    names.push(m[1]!.toLowerCase());
    rest = rest.slice(m[0].length);
  }

  if (names.length === 0) return { targets: [], missing: [] };

  const byName = new Map(sessions.map((s) => [s.name.toLowerCase(), s]));
  const targets: SessionInfo[] = [];
  const missing: string[] = [];

  for (const n of names) {
    const s = byName.get(n);
    if (s) {
      if (!targets.some((t) => t.id === s.id)) targets.push(s);
    } else {
      missing.push(n);
    }
  }

  return { targets, missing };
}
