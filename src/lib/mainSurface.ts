/**
 * Main work-surface workspace: tmux/Hyprland-like pane tree (chat + N terminals).
 * Separate from focused terminal overlay (`expandedSessionId`).
 */

import { derived, get, writable } from "svelte/store";

const KEY = "chatty.workspace.v2";

export type SplitDir = "row" | "col";

export type PaneNode =
  | { id: string; kind: "chat" }
  /** sessionId null = empty slot awaiting picker */
  | { id: string; kind: "term"; sessionId: string | null }
  | {
      id: string;
      kind: "split";
      dir: SplitDir;
      /** fraction of first child (a) */
      ratio: number;
      a: PaneNode;
      b: PaneNode;
    };

export type WorkspaceState = {
  root: PaneNode;
  focusedPaneId: string;
};

export type DropEdge = "left" | "right" | "up" | "down" | "center";

function nid(): string {
  return crypto.randomUUID();
}

function chatLeaf(): PaneNode {
  return { id: nid(), kind: "chat" };
}

function termLeaf(sessionId: string | null): PaneNode {
  return { id: nid(), kind: "term", sessionId };
}

export function defaultWorkspace(): WorkspaceState {
  const chat = chatLeaf();
  return { root: chat, focusedPaneId: chat.id };
}

/** Loose clamp — user manages sizing; tiny floor keeps splitters grabbable. */
function clampRatio(r: number) {
  return Math.min(0.95, Math.max(0.05, r));
}

function collectLeaves(node: PaneNode, out: PaneNode[] = []): PaneNode[] {
  if (node.kind === "split") {
    collectLeaves(node.a, out);
    collectLeaves(node.b, out);
  } else {
    out.push(node);
  }
  return out;
}

function findNode(node: PaneNode, id: string): PaneNode | null {
  if (node.id === id) return node;
  if (node.kind === "split") {
    return findNode(node.a, id) || findNode(node.b, id);
  }
  return null;
}

function mapNode(node: PaneNode, id: string, fn: (n: PaneNode) => PaneNode): PaneNode {
  if (node.id === id) return fn(node);
  if (node.kind === "split") {
    return {
      ...node,
      a: mapNode(node.a, id, fn),
      b: mapNode(node.b, id, fn),
    };
  }
  return node;
}

/** Remove leaf id; promote sibling. Returns null if tree empty. */
function removeLeaf(node: PaneNode, id: string): PaneNode | null {
  if (node.id === id) return null;
  if (node.kind !== "split") return node;
  if (node.a.id === id) return node.b;
  if (node.b.id === id) return node.a;
  const a = removeLeaf(node.a, id);
  const b = removeLeaf(node.b, id);
  if (!a && !b) return null;
  if (!a) return b;
  if (!b) return a;
  return { ...node, a, b };
}

function ensureChat(root: PaneNode | null): PaneNode {
  if (!root) return chatLeaf();
  const leaves = collectLeaves(root);
  if (leaves.some((l) => l.kind === "chat")) return root;
  const chat = chatLeaf();
  return {
    id: nid(),
    kind: "split",
    dir: "col",
    ratio: 0.45,
    a: chat,
    b: root,
  };
}

function migrateV1(raw: unknown): WorkspaceState | null {
  if (!raw || typeof raw !== "object") return null;
  const p = raw as Record<string, unknown>;
  if (p.mode === "chat") return defaultWorkspace();
  if (p.mode === "split" && typeof p.termSessionId === "string") {
    const chat = chatLeaf();
    const term = termLeaf(p.termSessionId);
    const dir = p.dir === "row" ? "row" : "col";
    const ratio = clampRatio(Number(p.ratio) || 0.45);
    if (p.termHidden) {
      return { root: chat, focusedPaneId: chat.id };
    }
    if (p.chatHidden) {
      return { root: term, focusedPaneId: term.id };
    }
    const split: PaneNode = {
      id: nid(),
      kind: "split",
      dir,
      ratio,
      a: chat,
      b: term,
    };
    return { root: split, focusedPaneId: term.id };
  }
  if (p.root && typeof p.root === "object" && typeof p.focusedPaneId === "string") {
    return p as WorkspaceState;
  }
  return null;
}

function load(): WorkspaceState {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) {
      const old = localStorage.getItem("chatty.mainSurface");
      if (old) {
        const m = migrateV1(JSON.parse(old));
        if (m) return m;
      }
      return defaultWorkspace();
    }
    const m = migrateV1(JSON.parse(raw));
    return m ?? defaultWorkspace();
  } catch {
    return defaultWorkspace();
  }
}

export const workspace = writable<WorkspaceState>(load());

workspace.subscribe((w) => {
  try {
    localStorage.setItem(KEY, JSON.stringify(w));
  } catch {
    /* ignore */
  }
});

/** @deprecated alias — prefer workspace */
export const mainSurface = workspace;

export const focusedPaneId = derived(workspace, ($w) => $w.focusedPaneId);

export const termSessionIdsInWorkspace = derived(workspace, ($w) =>
  collectLeaves($w.root)
    .filter((l): l is Extract<PaneNode, { kind: "term" }> => l.kind === "term")
    .map((l) => l.sessionId),
);

/** Focus composer when chat pane is active; focus xterm when a term pane is active. */
function applyPaneDomFocus(paneId: string) {
  if (typeof document === "undefined") return;
  const w = get(workspace);
  const node = findNode(w.root, paneId);
  queueMicrotask(() => {
    const composer = document.querySelector<HTMLInputElement>(
      "[data-composer-input]",
    );
    if (node?.kind === "chat") {
      composer?.focus({ preventScroll: true });
      return;
    }
    if (node?.kind === "term") {
      if (document.activeElement === composer) composer?.blur();
      const termTa = document.querySelector<HTMLTextAreaElement>(
        `[data-pane-id="${paneId}"] .xterm textarea`,
      );
      termTa?.focus({ preventScroll: true });
    }
  });
}

export function setFocusedPane(id: string) {
  workspace.update((w) => {
    if (!findNode(w.root, id)) return w;
    return { ...w, focusedPaneId: id };
  });
  applyPaneDomFocus(id);
}

/** Select the chat leaf (if any) and put typing in the composer. */
export function focusChatPane() {
  const w = get(workspace);
  const chat = collectLeaves(w.root).find((l) => l.kind === "chat");
  if (chat) {
    setFocusedPane(chat.id);
    return;
  }
  if (typeof document !== "undefined") {
    queueMicrotask(() => {
      document
        .querySelector<HTMLInputElement>("[data-composer-input]")
        ?.focus({ preventScroll: true });
    });
  }
}

export function setSplitRatio(splitId: string, ratio: number) {
  workspace.update((w) => ({
    ...w,
    root: mapNode(w.root, splitId, (n) =>
      n.kind === "split" ? { ...n, ratio: clampRatio(ratio) } : n,
    ),
  }));
}

/** Prefer parent split axis so stacks grow in the same direction. */
function preferredSplitDir(root: PaneNode, focusedId: string): SplitDir {
  const parent = findSplitParent(root, focusedId);
  if (parent) return parent.split.dir;
  return "col";
}

/**
 * Split the focused leaf.
 * @param dir col = side-by-side, row = stacked
 * @param sessionId for new term leaf; omit/null → empty picker slot
 */
export function splitFocused(
  dir: SplitDir,
  opts?: { sessionId?: string | null; newKind?: "chat" | "term" },
) {
  workspace.update((w) => {
    const focus = findNode(w.root, w.focusedPaneId);
    if (!focus || focus.kind === "split") return w;

    let newLeaf: PaneNode;
    const kind = opts?.newKind ?? "term";
    if (kind === "chat") {
      newLeaf = chatLeaf();
    } else {
      const sid =
        opts?.sessionId !== undefined
          ? opts.sessionId
          : focus.kind === "term"
            ? focus.sessionId
            : null;
      newLeaf = termLeaf(sid);
    }

    const split: PaneNode = {
      id: nid(),
      kind: "split",
      dir,
      ratio: 0.5,
      a: focus,
      b: newLeaf,
    };

    const root =
      w.root.id === focus.id
        ? split
        : mapNode(w.root, focus.id, () => split);

    return { root, focusedPaneId: newLeaf.id };
  });
}

export function assignSessionToPane(paneId: string, sessionId: string) {
  const sid = sessionId.trim();
  if (!sid) return;
  workspace.update((w) => ({
    ...w,
    root: mapNode(w.root, paneId, (n) =>
      n.kind === "term" ? { ...n, sessionId: sid } : n,
    ),
    focusedPaneId: paneId,
  }));
  const pending = get(replaceRestore);
  if (pending?.paneId === paneId) replaceRestore.set(null);
  applyPaneDomFocus(paneId);
}

/**
 * Always insert a new term leaf beside the focused leaf. Never rebinds.
 */
export function openSessionInNewPane(sessionId: string, dir?: SplitDir) {
  const id = sessionId.trim();
  if (!id) return;

  workspace.update((w) => {
    const focus = findNode(w.root, w.focusedPaneId);
    const splitDir = dir ?? preferredSplitDir(w.root, w.focusedPaneId);
    const term = termLeaf(id);

    // No useful leaf focus — wrap root
    if (!focus || focus.kind === "split") {
      const split: PaneNode = {
        id: nid(),
        kind: "split",
        dir: splitDir,
        ratio: 0.5,
        a: w.root,
        b: term,
      };
      return { root: split, focusedPaneId: term.id };
    }

    const split: PaneNode = {
      id: nid(),
      kind: "split",
      dir: splitDir,
      ratio: 0.5,
      a: focus,
      b: term,
    };
    const root =
      w.root.id === focus.id
        ? split
        : mapNode(w.root, focus.id, () => split);
    return { root, focusedPaneId: term.id };
  });

  const next = get(workspace).focusedPaneId;
  applyPaneDomFocus(next);
}

/** @deprecated use openSessionInNewPane — always creates a new pane */
export function openSessionInPane(sessionId: string) {
  openSessionInNewPane(sessionId);
}

export type ReplaceRestore = {
  paneId: string;
  previousSessionId: string | null;
};

/** Active replace-picker restore target (Esc restores previous session). */
export const replaceRestore = writable<ReplaceRestore | null>(null);

/**
 * Clear focused term so the session picker shows.
 * Returns previous session id for Esc-restore; null if not a term pane.
 */
export function beginReplaceFocusedPane(): ReplaceRestore | null {
  const w = get(workspace);
  const focus = findNode(w.root, w.focusedPaneId);
  if (!focus || focus.kind !== "term") return null;

  const previousSessionId = focus.sessionId;
  const info: ReplaceRestore = {
    paneId: focus.id,
    previousSessionId,
  };
  replaceRestore.set(info);
  workspace.update((state) => ({
    ...state,
    root: mapNode(state.root, focus.id, (n) =>
      n.kind === "term" ? { ...n, sessionId: null } : n,
    ),
    focusedPaneId: focus.id,
  }));
  return info;
}

/** Restore session after cancelling replace (does not close the pane). */
export function cancelReplacePane(
  paneId?: string,
  previousSessionId?: string | null,
) {
  const pending = get(replaceRestore);
  const id = paneId ?? pending?.paneId;
  const prev =
    previousSessionId !== undefined
      ? previousSessionId
      : (pending?.previousSessionId ?? null);
  if (!id) return;

  workspace.update((w) => {
    const node = findNode(w.root, id);
    if (!node || node.kind !== "term") return w;
    // Only restore if still empty (user may have picked already)
    if (node.sessionId != null) return w;
    return {
      ...w,
      root: mapNode(w.root, id, (n) =>
        n.kind === "term" ? { ...n, sessionId: prev } : n,
      ),
      focusedPaneId: id,
    };
  });
  if (pending?.paneId === id) replaceRestore.set(null);
  applyPaneDomFocus(id);
}

export type PaneDir = "left" | "right" | "up" | "down";

/** Find split parent of a node (leaf or nested split). */
function findSplitParent(
  node: PaneNode,
  childId: string,
): {
  split: Extract<PaneNode, { kind: "split" }>;
  child: "a" | "b";
} | null {
  if (node.kind !== "split") return null;
  if (node.a.id === childId) return { split: node, child: "a" };
  if (node.b.id === childId) return { split: node, child: "b" };
  return findSplitParent(node.a, childId) || findSplitParent(node.b, childId);
}

/**
 * Tree-first neighbor in a direction (tmux / tiling WM style).
 *
 * Climb the binary split tree until a split matches the axis and we can
 * step across it (e.g. row split + down while in the upper child). Then
 * pick the best-aligned leaf inside the destination subtree.
 *
 * This makes Alt+↑/↓ walk a column stack reliably, instead of pure
 * center-to-center geometry which often jumps to a sideways pane.
 */
function neighborLeafId(fromId: string, dir: PaneDir): string | null {
  const w = get(workspace);
  if (!findNode(w.root, fromId)) return null;

  // Climb until we can step across a matching-axis split.
  let currentId = fromId;
  for (let guard = 0; guard < 64; guard++) {
    const parent = findSplitParent(w.root, currentId);
    if (!parent) break;
    const { split, child } = parent;

    let dest: PaneNode | null = null;
    if (split.dir === "row") {
      // a = top, b = bottom
      if (dir === "down" && child === "a") dest = split.b;
      else if (dir === "up" && child === "b") dest = split.a;
    } else {
      // col: a = left, b = right
      if (dir === "right" && child === "a") dest = split.b;
      else if (dir === "left" && child === "b") dest = split.a;
    }

    if (dest) {
      const picked = pickLeafInSubtree(dest, fromId, dir);
      if (picked) return picked;
    }

    // Wrong axis or already on the far edge of this split — climb.
    currentId = split.id;
  }

  // Last resort: pure screen geometry.
  return geometricNeighbor(fromId, dir);
}

/** Prefer the leaf most aligned with `fromId` when entering a subtree. */
function pickLeafInSubtree(
  subtree: PaneNode,
  fromId: string,
  dir: PaneDir,
): string | null {
  const leaves = collectLeaves(subtree);
  if (leaves.length === 0) return null;
  if (leaves.length === 1) return leaves[0]!.id;

  // Tree-order fallback when DOM is unavailable.
  const treeFallback = () => {
    if (dir === "up" || dir === "left") return leaves[leaves.length - 1]!.id;
    return leaves[0]!.id;
  };

  if (typeof document === "undefined") return treeFallback();

  const fromEl = document.querySelector(
    `[data-pane-id="${fromId}"]`,
  ) as HTMLElement | null;
  if (!fromEl) return treeFallback();
  const fr = fromEl.getBoundingClientRect();

  let bestId: string | null = null;
  let bestScore = Infinity;

  for (const leaf of leaves) {
    const el = document.querySelector(
      `[data-pane-id="${leaf.id}"]`,
    ) as HTMLElement | null;
    if (!el) continue;
    const r = el.getBoundingClientRect();
    const score = alignmentScore(fr, r, dir);
    if (score < bestScore) {
      bestScore = score;
      bestId = leaf.id;
    }
  }

  return bestId ?? treeFallback();
}

/**
 * Lower is better. Heavily weight edge overlap on the perpendicular axis
 * so "down" prefers the pane directly below in the same column.
 */
function alignmentScore(
  from: DOMRect,
  to: DOMRect,
  dir: PaneDir,
): number {
  const overlapX =
    Math.max(0, Math.min(from.right, to.right) - Math.max(from.left, to.left)) /
    Math.max(1, Math.min(from.width, to.width));
  const overlapY =
    Math.max(0, Math.min(from.bottom, to.bottom) - Math.max(from.top, to.top)) /
    Math.max(1, Math.min(from.height, to.height));

  const fcx = from.left + from.width / 2;
  const fcy = from.top + from.height / 2;
  const tcx = to.left + to.width / 2;
  const tcy = to.top + to.height / 2;

  if (dir === "down" || dir === "up") {
    // Prefer strong horizontal alignment; then nearest along vertical.
    const along =
      dir === "down"
        ? Math.abs(to.top - from.bottom) + Math.abs(tcy - fcy) * 0.01
        : Math.abs(from.top - to.bottom) + Math.abs(tcy - fcy) * 0.01;
    return (1 - overlapX) * 10_000 + along;
  }
  // left / right
  const along =
    dir === "right"
      ? Math.abs(to.left - from.right) + Math.abs(tcx - fcx) * 0.01
      : Math.abs(from.left - to.right) + Math.abs(tcx - fcx) * 0.01;
  return (1 - overlapY) * 10_000 + along;
}

/** Screen-geometry neighbor (fallback when tree walk finds nothing). */
function geometricNeighbor(fromId: string, dir: PaneDir): string | null {
  if (typeof document === "undefined") return null;
  const curEl = document.querySelector(
    `[data-pane-id="${fromId}"]`,
  ) as HTMLElement | null;
  if (!curEl) return null;
  const fr = curEl.getBoundingClientRect();
  let bestId: string | null = null;
  let bestScore = Infinity;

  for (const el of document.querySelectorAll<HTMLElement>("[data-pane-id]")) {
    const id = el.getAttribute("data-pane-id");
    if (!id || id === fromId) continue;
    const r = el.getBoundingClientRect();
    const fcx = fr.left + fr.width / 2;
    const fcy = fr.top + fr.height / 2;
    const tcx = r.left + r.width / 2;
    const tcy = r.top + r.height / 2;
    const dx = tcx - fcx;
    const dy = tcy - fcy;

    // Must be predominantly in the requested direction.
    let ok = false;
    if (dir === "left") ok = dx < -4 && Math.abs(dx) >= Math.abs(dy) * 0.35;
    if (dir === "right") ok = dx > 4 && Math.abs(dx) >= Math.abs(dy) * 0.35;
    if (dir === "up") ok = dy < -4 && Math.abs(dy) >= Math.abs(dx) * 0.35;
    if (dir === "down") ok = dy > 4 && Math.abs(dy) >= Math.abs(dx) * 0.35;
    if (!ok) continue;

    const score = alignmentScore(fr, r, dir);
    if (score < bestScore) {
      bestScore = score;
      bestId = id;
    }
  }
  return bestId;
}

/** Focus nearest leaf in a screen direction (tree-aware). */
export function focusPaneDirection(dir: PaneDir) {
  const w = get(workspace);
  const next = neighborLeafId(w.focusedPaneId, dir);
  if (next) {
    setFocusedPane(next);
    return;
  }
  // No neighbor — stay put (don't jump arbitrarily).
}

/**
 * Nudge the split ratio affecting the focused leaf.
 * dir = which edge of the focused pane to push outward.
 */
export function resizePaneDirection(dir: PaneDir, step = 0.05) {
  workspace.update((w) => {
    let currentId = w.focusedPaneId;
    let guard = 0;
    while (guard++ < 32) {
      const parent = findSplitParent(w.root, currentId);
      if (!parent) break;
      const { split, child } = parent;
      const horizontal = split.dir === "col";
      const vertical = split.dir === "row";

      let delta = 0;
      if (horizontal && (dir === "left" || dir === "right")) {
        if (dir === "right") delta = child === "a" ? step : -step;
        if (dir === "left") delta = child === "a" ? -step : step;
      } else if (vertical && (dir === "up" || dir === "down")) {
        if (dir === "down") delta = child === "a" ? step : -step;
        if (dir === "up") delta = child === "a" ? -step : step;
      } else {
        currentId = split.id;
        continue;
      }

      const ratio = clampRatio(split.ratio + delta);
      return {
        ...w,
        root: mapNode(w.root, split.id, (n) =>
          n.kind === "split" ? { ...n, ratio } : n,
        ),
      };
    }
    return w;
  });
}

/**
 * Swap leaf payloads with geometric neighbor (keeps pane ids).
 * Focus follows the content that was focused (moves to the neighbor slot).
 */
export function swapWithNeighbor(dir: PaneDir) {
  const w = get(workspace);
  const before = w.focusedPaneId;
  const after = neighborLeafId(before, dir);
  if (!after) return;

  let focused = before;
  workspace.update((state) => {
    const a = findNode(state.root, before);
    const b = findNode(state.root, after);
    if (!a || !b || a.kind === "split" || b.kind === "split") return state;
    // Payload at `before` moves to `after` — follow it.
    let root = mapNode(state.root, before, () => ({ ...b, id: before }));
    root = mapNode(root, after, () => ({ ...a, id: after }));
    focused = after;
    return { root, focusedPaneId: after };
  });
  applyPaneDomFocus(focused);
}

/**
 * Swap two leaf payloads by id (center drop).
 * Focus follows the content that was at `idA` (to `idB`).
 */
export function swapLeaves(idA: string, idB: string) {
  if (idA === idB) return;
  let focused = idA;
  workspace.update((state) => {
    const a = findNode(state.root, idA);
    const b = findNode(state.root, idB);
    if (!a || !b || a.kind === "split" || b.kind === "split") return state;
    // Content from idA lands on idB — follow it.
    let root = mapNode(state.root, idA, () => ({ ...b, id: idA }));
    root = mapNode(root, idB, () => ({ ...a, id: idB }));
    focused = idB;
    return { root, focusedPaneId: idB };
  });
  applyPaneDomFocus(focused);
}

/**
 * Detach `leafId` and insert it against `targetId` on `edge`.
 * - center → swapLeaves
 * - left/right → col split; up/down → row split
 */
export function reparentLeaf(
  leafId: string,
  targetId: string,
  edge: DropEdge,
) {
  if (leafId === targetId) return;

  if (edge === "center") {
    swapLeaves(leafId, targetId);
    return;
  }

  workspace.update((state) => {
    const leaf = findNode(state.root, leafId);
    const target = findNode(state.root, targetId);
    if (!leaf || !target) return state;
    if (leaf.kind === "split" || target.kind === "split") return state;

    // Snapshot leaf payload with same id (stable for xterm mount keys).
    const moved: PaneNode = { ...leaf };

    let root = removeLeaf(state.root, leafId);
    if (!root) return state;

    const targetNow = findNode(root, targetId);
    if (!targetNow || targetNow.kind === "split") {
      // Should not happen for leaf targets; abort without applying remove.
      return state;
    }

    const dir: SplitDir =
      edge === "left" || edge === "right" ? "col" : "row";
    // a = first (left/top), b = second (right/bottom)
    const a: PaneNode =
      edge === "left" || edge === "up" ? moved : targetNow;
    const b: PaneNode =
      edge === "left" || edge === "up" ? targetNow : moved;

    const split: PaneNode = {
      id: nid(),
      kind: "split",
      dir,
      ratio: 0.5,
      a,
      b,
    };

    root =
      root.id === targetId
        ? split
        : mapNode(root, targetId, () => split);

    return { root, focusedPaneId: leafId };
  });
  applyPaneDomFocus(leafId);
}

/**
 * Move focused pane into the geometric neighbor region (detach + re-split).
 */
export function movePaneDirection(dir: PaneDir) {
  const w = get(workspace);
  const from = w.focusedPaneId;
  const target = neighborLeafId(from, dir);
  if (!target) return;

  // Move toward neighbor: place on the side we were "coming from"
  // e.g. move right → insert on left edge of neighbor (adjacent)
  const edge: DropEdge =
    dir === "left"
      ? "right"
      : dir === "right"
        ? "left"
        : dir === "up"
          ? "down"
          : "up";
  reparentLeaf(from, target, edge);
}

/** Flip parent split orientation of focused leaf (row ↔ col). */
export function flipSplitOrientation() {
  workspace.update((w) => {
    const parent = findSplitParent(w.root, w.focusedPaneId);
    if (!parent) return w;
    return {
      ...w,
      root: mapNode(w.root, parent.split.id, (n) =>
        n.kind === "split"
          ? { ...n, dir: n.dir === "col" ? "row" : "col" }
          : n,
      ),
    };
  });
}

/** Close focused pane (or specific id). Term close ≠ kill session. */
export function closePane(paneId?: string) {
  workspace.update((w) => {
    const id = paneId ?? w.focusedPaneId;
    const target = findNode(w.root, id);
    if (!target || target.kind === "split") return w;

    let next = removeLeaf(w.root, id);
    next = ensureChat(next);

    const leaves = collectLeaves(next);
    const focusedPaneId = leaves.some((l) => l.id === w.focusedPaneId)
      ? w.focusedPaneId
      : leaves[0]!.id;

    return { root: next, focusedPaneId };
  });
}

export function closeTermPane() {
  const w = get(workspace);
  const focus = findNode(w.root, w.focusedPaneId);
  if (focus?.kind === "term") {
    closePane(focus.id);
    return;
  }
  const term = collectLeaves(w.root).find((l) => l.kind === "term");
  if (term) closePane(term.id);
}

export function focusNextPane(delta: 1 | -1 = 1) {
  let nextId: string | null = null;
  workspace.update((w) => {
    const leaves = collectLeaves(w.root);
    if (leaves.length === 0) return w;
    let idx = leaves.findIndex((l) => l.id === w.focusedPaneId);
    if (idx < 0) idx = 0;
    else idx = (idx + delta + leaves.length) % leaves.length;
    nextId = leaves[idx]!.id;
    return { ...w, focusedPaneId: nextId };
  });
  if (nextId) applyPaneDomFocus(nextId);
}

export function onSessionRemovedFromSurface(sessionId: string) {
  const w = get(workspace);
  const terms = collectLeaves(w.root).filter(
    (l): l is Extract<PaneNode, { kind: "term" }> =>
      l.kind === "term" && l.sessionId === sessionId,
  );
  for (const t of terms) {
    closePane(t.id);
  }
}

// --- legacy shims used by older call sites ---

export function hideChatPane() {
  /* no-op: use closePane on chat leaf if desired */
}

export function showChatPane() {
  /* no-op */
}

export function hideTermPane() {
  closeTermPane();
}

export function showTermPane() {
  /* no-op */
}

export const termPaneSessionId = derived(workspace, ($w) => {
  const focus = findNode($w.root, $w.focusedPaneId);
  if (focus?.kind === "term") return focus.sessionId;
  const t = collectLeaves($w.root).find((l) => l.kind === "term");
  return t && t.kind === "term" ? t.sessionId : null;
});

export const hasTermPane = derived(
  workspace,
  ($w) => collectLeaves($w.root).some((l) => l.kind === "term"),
);

export const surfacePaneFocus = {
  set(v: "chat" | "term") {
    const w = get(workspace);
    const leaves = collectLeaves(w.root);
    const leaf =
      v === "chat"
        ? leaves.find((l) => l.kind === "chat")
        : leaves.find((l) => l.kind === "term");
    if (leaf) setFocusedPane(leaf.id);
  },
  subscribe: focusedPaneId.subscribe,
};
