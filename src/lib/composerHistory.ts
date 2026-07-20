/**
 * Persistent composer command history (↑ / ↓ in the input).
 * Stored in localStorage so it survives restarts.
 */

const STORAGE_KEY = "chatty.composerHistory";
const MAX_ENTRIES = 200;

export function loadComposerHistory(): string[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((x): x is string => typeof x === "string" && x.trim().length > 0)
      .slice(0, MAX_ENTRIES);
  } catch {
    return [];
  }
}

export function saveComposerHistory(entries: string[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(entries.slice(0, MAX_ENTRIES)));
  } catch {
    /* quota / private mode */
  }
}

/** Newest-first. Drops consecutive duplicates of the same line. */
export function pushComposerHistory(entries: string[], command: string): string[] {
  const line = command.replace(/\s+$/, "");
  if (!line.trim()) return entries;
  const next = entries[0] === line ? entries : [line, ...entries.filter((e) => e !== line)];
  const trimmed = next.slice(0, MAX_ENTRIES);
  saveComposerHistory(trimmed);
  return trimmed;
}
