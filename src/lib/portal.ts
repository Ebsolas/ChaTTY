/**
 * Svelte action: move a node under `document.body` (or a custom target)
 * so fixed-position popups are not clipped by overflow:hidden rails/grid cells.
 *
 * Destroy only removes the node — never re-inserts it into the component tree.
 * Re-inserting on destroy races Svelte's unmount and can leave a visible orphan
 * on body while component state says the menu is closed.
 */
export function portal(node: HTMLElement, target: HTMLElement | null = null) {
  const host = () => target ?? document.body;
  host().appendChild(node);

  return {
    update(newTarget: HTMLElement | null = null) {
      target = newTarget;
      const next = host();
      if (node.parentNode !== next) {
        next.appendChild(node);
      }
    },
    destroy() {
      node.remove();
    },
  };
}

/** Keep a fixed popup inside the viewport with a small margin. */
export function clampPopupPosition(
  left: number,
  top: number,
  width: number,
  height: number,
  margin = 8,
): { left: number; top: number } {
  const maxL = Math.max(margin, window.innerWidth - width - margin);
  const maxT = Math.max(margin, window.innerHeight - height - margin);
  return {
    left: Math.min(Math.max(margin, left), maxL),
    top: Math.min(Math.max(margin, top), maxT),
  };
}
