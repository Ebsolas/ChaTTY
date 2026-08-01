/**
 * Shell launch profiles (L2).
 * Spawn templates from ~/.config/chatty/profiles.json — not session history.
 */
import { invoke } from "@tauri-apps/api/core";

export interface CaptureHints {
  flavor: string;
}

export interface ShellProfile {
  id: string;
  label: string;
  shell: string;
  args: string[];
  cwd?: string | null;
  env?: Record<string, string>;
  capture?: CaptureHints;
  /** "shell" (default) | "ssh" — ssh prompts for destination at create time. */
  kind?: string;
}

/** Whether this profile launches SSH (needs a destination at create time). */
export function profileIsSsh(p: ShellProfile): boolean {
  if (p.kind?.toLowerCase() === "ssh") return true;
  const base = p.shell.split(/[/\\]/).pop()?.toLowerCase() ?? "";
  return base === "ssh" || base === "ssh.exe";
}

const SSH_RECENT_KEY = "chatty.ssh.recentTargets";
const SSH_RECENT_MAX = 12;

export function loadRecentSshTargets(): string[] {
  try {
    const raw = localStorage.getItem(SSH_RECENT_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((x): x is string => typeof x === "string" && x.trim().length > 0)
      .map((s) => s.trim())
      .slice(0, SSH_RECENT_MAX);
  } catch {
    return [];
  }
}

export function rememberSshTarget(target: string): void {
  const t = target.trim();
  if (!t) return;
  const prev = loadRecentSshTargets().filter(
    (x) => x.toLowerCase() !== t.toLowerCase(),
  );
  const next = [t, ...prev].slice(0, SSH_RECENT_MAX);
  try {
    localStorage.setItem(SSH_RECENT_KEY, JSON.stringify(next));
  } catch {
    /* quota / private mode */
  }
}

export interface ProfilesPayload {
  defaultProfileId: string;
  profiles: ShellProfile[];
  sourcePath: string;
}

export async function listShellProfiles(): Promise<ProfilesPayload> {
  return invoke<ProfilesPayload>("list_shell_profiles");
}
