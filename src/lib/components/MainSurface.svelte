<script lang="ts">
  import type { ChatMessage, SessionInfo } from "$lib/types";
  import {
    assignSessionToPane,
    beginReplaceFocusedPane,
    cancelReplacePane,
    closePane,
    reparentLeaf,
    replaceRestore,
    setFocusedPane,
    setSplitRatio,
    splitFocused,
    workspace,
    type DropEdge,
    type PaneNode,
  } from "$lib/mainSurface";
  import { chatZoomKey, getPaneZoom, paneZoomKey, paneZooms } from "$lib/zoom";
  import ChatView from "./ChatView.svelte";
  import MainViewHeader from "./MainViewHeader.svelte";
  import SessionTerminal from "./SessionTerminal.svelte";
  import { portal } from "$lib/portal";

  interface Props {
    messages: ChatMessage[];
    sessions: SessionInfo[];
    conversationTitle: string;
    sessionCountLabel?: string;
    /** Sessions in the active conversation (for pickers). */
    activeSessions?: SessionInfo[];
    onOpenSession?: (sessionId: string) => void;
  }

  let {
    messages,
    sessions,
    conversationTitle,
    sessionCountLabel = "",
    activeSessions = [],
    onOpenSession,
  }: Props = $props();

  const ws = $derived($workspace);
  const pendingReplace = $derived($replaceRestore);
  const zooms = $derived($paneZooms);
  const pickList = $derived(
    activeSessions.length > 0 ? activeSessions : sessions,
  );

  function zoomForPane(paneId: string, kind: "chat" | "term"): number {
    const key = kind === "chat" ? chatZoomKey() : paneZoomKey(paneId);
    return zooms[key] ?? getPaneZoom(key);
  }

  let pickerFilter = $state("");
  let pickerHighlight = $state(0);
  let pickerInputEl: HTMLInputElement | undefined = $state();
  let ctxMenu: { x: number; y: number; paneId: string } | null = $state(null);

  // ── Drag-and-drop reorg ──────────────────────────────────────────
  type DragState = {
    leafId: string;
    label: string;
    x: number;
    y: number;
    overId: string | null;
    edge: DropEdge | null;
  };
  let drag: DragState | null = $state(null);
  let dragStarted = false;

  function sessionName(id: string): string {
    return sessions.find((s) => s.id === id)?.name ?? "session";
  }

  function sessionMeta(id: string): SessionInfo | undefined {
    return sessions.find((s) => s.id === id);
  }

  function statusLabel(s: SessionInfo | undefined): string {
    if (!s) return "";
    if (s.starting || s.status === "starting") return "starting";
    if (s.activity === "tui" || s.tuiActive) return "tui";
    if (s.activity === "busy") return s.lastCommand?.slice(0, 24) || "busy";
    if (s.status === "exited") return "exited";
    return "running";
  }

  function filteredPick(filter: string): SessionInfo[] {
    const q = filter.trim().toLowerCase();
    if (!q) return pickList;
    return pickList.filter(
      (s) =>
        s.name.toLowerCase().includes(q) ||
        s.id.toLowerCase().includes(q),
    );
  }

  function isReplacePane(paneId: string): boolean {
    return pendingReplace?.paneId === paneId;
  }

  function onPickerKeydown(
    e: KeyboardEvent,
    paneId: string,
    picks: SessionInfo[],
  ) {
    if (e.altKey || e.metaKey || e.ctrlKey) return;
    const key = e.key;
    const t = e.target as HTMLElement | null;
    const typingFilter =
      t instanceof HTMLInputElement && t.classList.contains("picker-input");
    const down =
      key === "ArrowDown" ||
      (!typingFilter && (key === "j" || key === "J"));
    const up =
      key === "ArrowUp" ||
      (!typingFilter && (key === "k" || key === "K"));

    if (down) {
      e.preventDefault();
      e.stopPropagation();
      if (picks.length === 0) return;
      pickerHighlight = (pickerHighlight + 1) % picks.length;
      return;
    }
    if (up) {
      e.preventDefault();
      e.stopPropagation();
      if (picks.length === 0) return;
      pickerHighlight =
        (pickerHighlight - 1 + picks.length) % picks.length;
      return;
    }
    if (key === "Enter") {
      e.preventDefault();
      e.stopPropagation();
      const s = picks[pickerHighlight] ?? picks[0];
      if (s) {
        assignSessionToPane(paneId, s.id);
        pickerFilter = "";
        pickerHighlight = 0;
      }
      return;
    }
    if (key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      if (isReplacePane(paneId)) {
        cancelReplacePane(paneId);
      } else {
        closePane(paneId);
      }
      pickerFilter = "";
      pickerHighlight = 0;
      return;
    }
    if (key === "Home" && picks.length > 0) {
      e.preventDefault();
      e.stopPropagation();
      pickerHighlight = 0;
      return;
    }
    if (key === "End" && picks.length > 0) {
      e.preventDefault();
      e.stopPropagation();
      pickerHighlight = picks.length - 1;
    }
  }

  // Window capture so hjkl/arrows work even if focus isn't inside the picker yet.
  $effect(() => {
    const focusId = ws.focusedPaneId;
    function hasEmptyTerm(n: PaneNode): string | null {
      if (n.kind === "term" && !n.sessionId && n.id === focusId) return n.id;
      if (n.kind === "split") {
        return hasEmptyTerm(n.a) ?? hasEmptyTerm(n.b);
      }
      return null;
    }
    const emptyId = hasEmptyTerm(ws.root);
    if (!emptyId) return;

    const onKey = (e: KeyboardEvent) => {
      const picks = filteredPick(pickerFilter);
      onPickerKeydown(e, emptyId, picks);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  });

  function openCtx(e: MouseEvent, paneId: string) {
    e.preventDefault();
    e.stopPropagation();
    setFocusedPane(paneId);
    ctxMenu = { x: e.clientX, y: e.clientY, paneId };
  }

  function closeCtx() {
    ctxMenu = null;
  }

  // Focus session picker input when an empty term leaf is focused.
  $effect(() => {
    const focus = ws.focusedPaneId;
    const root = ws.root;
    function findEmptyTerm(n: PaneNode): boolean {
      if (n.kind === "term" && n.id === focus && !n.sessionId) return true;
      if (n.kind === "split") {
        return findEmptyTerm(n.a) || findEmptyTerm(n.b);
      }
      return false;
    }
    if (!findEmptyTerm(root)) return;
    requestAnimationFrame(() => {
      pickerInputEl?.focus();
      pickerInputEl?.select();
    });
  });

  function edgeFromPoint(
    el: HTMLElement,
    clientX: number,
    clientY: number,
  ): DropEdge {
    const r = el.getBoundingClientRect();
    const x = (clientX - r.left) / Math.max(r.width, 1);
    const y = (clientY - r.top) / Math.max(r.height, 1);
    const edgeBand = 0.25;
    if (x < edgeBand) return "left";
    if (x > 1 - edgeBand) return "right";
    if (y < edgeBand) return "up";
    if (y > 1 - edgeBand) return "down";
    return "center";
  }

  function hitLeafAt(clientX: number, clientY: number): HTMLElement | null {
    const stack = document.elementsFromPoint(clientX, clientY);
    for (const el of stack) {
      if (!(el instanceof HTMLElement)) continue;
      if (el.classList.contains("pane-drag-ghost")) continue;
      if (el.classList.contains("drop-zone")) continue;
      const leaf = el.closest("[data-pane-id]") as HTMLElement | null;
      if (leaf) return leaf;
    }
    return null;
  }

  function startPaneDrag(
    e: PointerEvent,
    leafId: string,
    label: string,
  ) {
    if (e.button !== 0) return;
    // Don't start drag from interactive controls inside the bar.
    const t = e.target as HTMLElement | null;
    if (t?.closest("button, input, a")) return;

    e.preventDefault();
    e.stopPropagation();
    setFocusedPane(leafId);

    const startX = e.clientX;
    const startY = e.clientY;
    dragStarted = false;
    const handle = e.currentTarget as HTMLElement;

    const onMove = (ev: PointerEvent) => {
      const dx = ev.clientX - startX;
      const dy = ev.clientY - startY;
      if (!dragStarted && dx * dx + dy * dy < 16) return;
      if (!dragStarted) {
        dragStarted = true;
        try {
          handle.setPointerCapture(ev.pointerId);
        } catch {
          /* ignore */
        }
        document.body.classList.add("pane-dragging");
      }
      const over = hitLeafAt(ev.clientX, ev.clientY);
      const overId = over?.getAttribute("data-pane-id") ?? null;
      let edge: DropEdge | null = null;
      if (over && overId && overId !== leafId) {
        edge = edgeFromPoint(over, ev.clientX, ev.clientY);
      }
      drag = {
        leafId,
        label,
        x: ev.clientX,
        y: ev.clientY,
        overId: overId !== leafId ? overId : null,
        edge,
      };
    };

    const onUp = (ev: PointerEvent) => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
      document.body.classList.remove("pane-dragging");
      try {
        handle.releasePointerCapture(ev.pointerId);
      } catch {
        /* ignore */
      }

      if (dragStarted && drag?.overId && drag.edge) {
        reparentLeaf(drag.leafId, drag.overId, drag.edge);
      }
      drag = null;
      dragStarted = false;
    };

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
  }

  function cancelDrag() {
    if (!drag) return;
    drag = null;
    dragStarted = false;
    document.body.classList.remove("pane-dragging");
  }
</script>

<svelte:window
  onclick={() => closeCtx()}
  onkeydown={(e) => {
    if (e.key === "Escape") {
      if (drag) {
        e.preventDefault();
        cancelDrag();
        return;
      }
      closeCtx();
    }
  }}
/>

{#snippet renderNode(node: PaneNode)}
  {#if node.kind === "split"}
    {@const split = node}
    <div
      class="split"
      class:dir-col={split.dir === "col"}
      class:dir-row={split.dir === "row"}
      style:--split-ratio={split.ratio}
      data-split-id={split.id}
    >
      <div class="split-child first">
        {@render renderNode(split.a)}
      </div>
      <!-- svelte-ignore a11y_no_static_element_interactions -->
      <div
        class="splitter"
        role="separator"
        aria-orientation={split.dir === "col" ? "vertical" : "horizontal"}
        aria-label="Resize panes"
        onpointerdown={(e) => {
          e.preventDefault();
          e.stopPropagation();
          const el = e.currentTarget as HTMLElement;
          const parent = el.parentElement;
          if (!parent) return;
          el.setPointerCapture(e.pointerId);
          const d = split.dir;
          const onMove = (ev: PointerEvent) => {
            const rect = parent.getBoundingClientRect();
            if (d === "col") {
              if (rect.width < 8) return;
              setSplitRatio(split.id, (ev.clientX - rect.left) / rect.width);
            } else {
              if (rect.height < 8) return;
              setSplitRatio(split.id, (ev.clientY - rect.top) / rect.height);
            }
          };
          const onUp = (ev: PointerEvent) => {
            try {
              el.releasePointerCapture(ev.pointerId);
            } catch {
              /* ignore */
            }
            window.removeEventListener("pointermove", onMove);
            window.removeEventListener("pointerup", onUp);
          };
          window.addEventListener("pointermove", onMove);
          window.addEventListener("pointerup", onUp);
        }}
      ></div>
      <div class="split-child second">
        {@render renderNode(split.b)}
      </div>
    </div>
  {:else if node.kind === "chat"}
    <!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
    <div
      class="leaf chat-leaf"
      class:focused={ws.focusedPaneId === node.id}
      class:drop-target={drag && drag.overId === node.id}
      data-pane-id={node.id}
      role="presentation"
      style:--pane-zoom={zoomForPane(node.id, "chat")}
      onclick={() => setFocusedPane(node.id)}
      oncontextmenu={(e) => openCtx(e, node.id)}
    >
      <!-- svelte-ignore a11y_no_static_element_interactions -->
      <div
        class="pane-id-bar chat-id drag-handle"
        title="Chat pane — drag to reorganize · Ctrl± zoom pane"
        onpointerdown={(e) => startPaneDrag(e, node.id, "Chat")}
      >
        <span class="pane-id-label">Chat</span>
        <span class="pane-id-meta muted">{conversationTitle}</span>
        {#if zoomForPane(node.id, "chat") !== 1}
          <span class="pane-zoom-badge muted"
            >{Math.round(zoomForPane(node.id, "chat") * 100)}%</span
          >
        {/if}
        <span class="drag-hint muted" aria-hidden="true">⋮⋮</span>
      </div>
      <div class="chat-zoom-host">
        <ChatView {messages} {onOpenSession} />
      </div>
      {#if drag && drag.overId === node.id && drag.edge}
        <div class="drop-zone" class:edge={drag.edge} data-edge={drag.edge}></div>
      {/if}
    </div>
  {:else}
    <!-- term -->
    <!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
    <div
      class="leaf term-leaf"
      class:focused={ws.focusedPaneId === node.id}
      class:drop-target={drag && drag.overId === node.id}
      data-pane-id={node.id}
      role="presentation"
      onclick={() => setFocusedPane(node.id)}
      oncontextmenu={(e) => openCtx(e, node.id)}
    >
      {#if node.sessionId && sessions.some((s) => s.id === node.sessionId)}
        {@const meta = sessionMeta(node.sessionId)}
        {@const st = statusLabel(meta)}
        {@const label = `@${sessionName(node.sessionId)}`}
        <!-- svelte-ignore a11y_no_static_element_interactions -->
        <div
          class="pane-id-bar term-id drag-handle"
          class:busy={meta?.activity === "busy"}
          class:tui={meta?.activity === "tui" || meta?.tuiActive}
          class:exited={meta?.status === "exited"}
          title={`${label}${st ? ` · ${st}` : ""} — drag to reorganize · Ctrl± zoom pane`}
          onpointerdown={(e) => startPaneDrag(e, node.id, label)}
        >
          <span
            class="status-dot"
            class:running={meta?.status === "running" && meta?.activity === "idle"}
            class:busy-dot={meta?.activity === "busy"}
            class:tui-dot={meta?.activity === "tui" || meta?.tuiActive}
            class:exited={meta?.status === "exited"}
            aria-hidden="true"
          ></span>
          <span class="pane-id-label mono">{label}</span>
          {#if st}
            <span class="pane-id-meta muted">{st}</span>
          {/if}
          {#if zoomForPane(node.id, "term") !== 1}
            <span class="pane-zoom-badge muted"
              >{Math.round(zoomForPane(node.id, "term") * 100)}%</span
            >
          {/if}
          <span class="drag-hint muted" aria-hidden="true">⋮⋮</span>
        </div>
        {#key node.sessionId + node.id}
          <SessionTerminal
            sessionId={node.sessionId}
            sessionName={sessionName(node.sessionId)}
            variant="embedded"
            bare={true}
            zoomKey={paneZoomKey(node.id)}
          />
        {/key}
      {:else}
        {@const picks = filteredPick(pickerFilter)}
        {@const replacing = isReplacePane(node.id)}
        <!-- svelte-ignore a11y_no_static_element_interactions a11y_click_events_have_key_events -->
        <div
          class="session-picker"
          role="presentation"
          onclick={(e) => e.stopPropagation()}
          onkeydown={(e) => onPickerKeydown(e, node.id, picks)}
        >
          <div class="picker-title">
            {replacing
              ? "Replace session in this pane"
              : "Choose session for this pane"}
          </div>
          <p class="picker-hint muted">
            ↑↓ select · j/k when not filtering · Enter open · Esc
            {replacing ? " restore" : " cancel"}
          </p>
          <input
            bind:this={pickerInputEl}
            class="picker-input mono"
            type="text"
            placeholder="Filter @name…"
            bind:value={pickerFilter}
            oninput={() => {
              pickerHighlight = 0;
            }}
          />
          <ul class="picker-list" role="listbox">
            {#each picks as s, i (s.id)}
              <li>
                <button
                  type="button"
                  class="picker-item mono"
                  class:highlight={i === pickerHighlight}
                  role="option"
                  aria-selected={i === pickerHighlight}
                  onmouseenter={() => (pickerHighlight = i)}
                  onclick={() => {
                    assignSessionToPane(node.id, s.id);
                    pickerFilter = "";
                    pickerHighlight = 0;
                  }}
                >
                  @{s.name}
                  {#if s.activity === "busy" || s.activity === "tui"}
                    <span class="muted">{s.activity}</span>
                  {/if}
                </button>
              </li>
            {:else}
              <li class="muted empty-pick">No sessions match</li>
            {/each}
          </ul>
          <button
            type="button"
            class="picker-cancel"
            onclick={() => {
              if (replacing) cancelReplacePane(node.id);
              else closePane(node.id);
            }}
          >
            {replacing ? "Cancel (restore)" : "Cancel (close pane)"}
          </button>
        </div>
      {/if}
      {#if drag && drag.overId === node.id && drag.edge}
        <div class="drop-zone" class:edge={drag.edge} data-edge={drag.edge}></div>
      {/if}
    </div>
  {/if}
{/snippet}

<div class="main-view">
  <MainViewHeader title={conversationTitle} subtitle={sessionCountLabel} />
  <div class="workspace">
    {@render renderNode(ws.root)}
  </div>
</div>

{#if ctxMenu}
  <!-- svelte-ignore a11y_click_events_have_key_events a11y_interactive_supports_focus -->
  <div
    class="pane-ctx"
    use:portal
    role="menu"
    tabindex="-1"
    style:left="{Math.min(ctxMenu.x, window.innerWidth - 200)}px"
    style:top="{Math.min(ctxMenu.y, window.innerHeight - 260)}px"
    onclick={(e) => e.stopPropagation()}
  >
    <button
      type="button"
      class="ctx-item"
      role="menuitem"
      onclick={() => {
        setFocusedPane(ctxMenu!.paneId);
        splitFocused("col", { newKind: "term", sessionId: null });
        closeCtx();
      }}
    >
      Split right
    </button>
    <button
      type="button"
      class="ctx-item"
      role="menuitem"
      onclick={() => {
        setFocusedPane(ctxMenu!.paneId);
        splitFocused("row", { newKind: "term", sessionId: null });
        closeCtx();
      }}
    >
      Split down
    </button>
    <button
      type="button"
      class="ctx-item"
      role="menuitem"
      onclick={() => {
        setFocusedPane(ctxMenu!.paneId);
        beginReplaceFocusedPane();
        closeCtx();
      }}
    >
      Replace session…
    </button>
    <button
      type="button"
      class="ctx-item"
      role="menuitem"
      onclick={() => {
        closePane(ctxMenu!.paneId);
        closeCtx();
      }}
    >
      Close pane
    </button>
  </div>
{/if}

{#if drag}
  <div
    class="pane-drag-ghost mono"
    use:portal
    style:left="{drag.x + 12}px"
    style:top="{drag.y + 12}px"
  >
    {drag.label}
    {#if drag.edge}
      <span class="ghost-edge muted">→ {drag.edge}</span>
    {/if}
  </div>
{/if}

<style>
  .main-view {
    flex: 1 1 auto;
    min-height: 0;
    min-width: 0;
    display: flex;
    flex-direction: column;
    background: var(--bg, #0f1115);
  }

  .workspace {
    flex: 1 1 auto;
    min-height: 0;
    min-width: 0;
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }

  .workspace > :global(.split),
  .workspace > :global(.leaf) {
    flex: 1 1 auto;
    min-height: 0;
    min-width: 0;
  }

  .split {
    display: flex;
    min-height: 0;
    min-width: 0;
    flex: 1 1 auto;
    height: 100%;
  }

  .split.dir-col {
    flex-direction: row;
  }

  .split.dir-row {
    flex-direction: column;
  }

  .split-child {
    min-width: 0;
    min-height: 0;
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }

  .split.dir-col > .first {
    flex: 0 0 calc(var(--split-ratio, 0.5) * 100%);
    max-width: calc(var(--split-ratio, 0.5) * 100%);
  }

  .split.dir-col > .second {
    flex: 1 1 auto;
  }

  .split.dir-row > .first {
    flex: 0 0 calc(var(--split-ratio, 0.5) * 100%);
    max-height: calc(var(--split-ratio, 0.5) * 100%);
  }

  .split.dir-row > .second {
    flex: 1 1 auto;
  }

  .split-child > :global(.split),
  .split-child > :global(.leaf) {
    flex: 1 1 auto;
    min-height: 0;
    min-width: 0;
    height: 100%;
  }

  .splitter {
    flex: 0 0 5px;
    position: relative;
    z-index: 3;
    background: transparent;
  }

  .dir-col > .splitter {
    cursor: col-resize;
  }

  .dir-row > .splitter {
    cursor: row-resize;
  }

  .splitter::after {
    content: "";
    position: absolute;
    background: var(--border, #232833);
    opacity: 0.9;
  }

  .dir-col > .splitter::after {
    top: 0;
    bottom: 0;
    left: 2px;
    width: 1px;
  }

  .dir-row > .splitter::after {
    left: 0;
    right: 0;
    top: 2px;
    height: 1px;
  }

  .splitter:hover::after {
    background: var(--accent, #4c8dff);
    opacity: 1;
  }

  .dir-col > .splitter:hover::after {
    width: 2px;
    left: 1.5px;
  }

  .leaf {
    min-width: 0;
    min-height: 0;
    height: 100%;
    display: flex;
    flex-direction: column;
    overflow: hidden;
    position: relative;
  }

  .leaf.focused {
    box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--accent, #4c8dff) 40%, transparent);
  }

  .leaf.focused > .pane-id-bar {
    background: color-mix(in srgb, var(--accent, #4c8dff) 12%, var(--bg-panel, #12151c));
    border-bottom-color: color-mix(in srgb, var(--accent, #4c8dff) 35%, var(--border, #232833));
  }

  .pane-id-bar {
    flex: 0 0 auto;
    display: flex;
    align-items: center;
    gap: 0.4rem;
    min-height: 1.55rem;
    padding: 0.2rem 0.55rem;
    border-bottom: 1px solid var(--border, #232833);
    background: var(--bg-panel, #12151c);
    overflow: hidden;
  }

  .drag-handle {
    cursor: grab;
    user-select: none;
    touch-action: none;
  }

  .drag-handle:active {
    cursor: grabbing;
  }

  .drag-hint {
    margin-left: auto;
    font-size: 0.65rem;
    letter-spacing: -0.05em;
    opacity: 0.45;
  }

  .pane-id-label {
    font-size: 0.78rem;
    font-weight: 600;
    color: var(--text, #e8eaed);
    flex-shrink: 0;
  }

  .pane-id-meta {
    font-size: 0.68rem;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .term-id.busy .pane-id-meta {
    color: var(--accent, #4c8dff);
  }

  .term-id.tui .pane-id-meta {
    color: #c792ea;
  }

  .term-id.exited .pane-id-label {
    color: #e35d6a;
  }

  .status-dot {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: var(--muted, #8b93a7);
    flex-shrink: 0;
  }

  .status-dot.running {
    background: var(--ok, #3dd68c);
    box-shadow: 0 0 6px color-mix(in srgb, var(--ok, #3dd68c) 50%, transparent);
  }

  .status-dot.busy-dot {
    background: var(--accent, #4c8dff);
    box-shadow: 0 0 6px color-mix(in srgb, var(--accent, #4c8dff) 50%, transparent);
  }

  .status-dot.tui-dot {
    background: #c792ea;
    box-shadow: 0 0 6px color-mix(in srgb, #c792ea 50%, transparent);
  }

  .status-dot.exited {
    background: #e35d6a;
  }

  .chat-zoom-host {
    flex: 1 1 auto;
    min-height: 0;
    min-width: 0;
    display: flex;
    flex-direction: column;
    overflow: hidden;
    /* Chromium/WebView — scales chat text + bubbles independently of app zoom */
    zoom: var(--pane-zoom, 1);
  }

  .chat-zoom-host > :global(.chat) {
    flex: 1 1 auto;
    min-height: 0;
  }

  .pane-zoom-badge {
    font-size: 0.65rem;
    flex-shrink: 0;
  }

  .term-leaf {
    background: #0d1017;
  }

  .term-leaf > :global(.term-shell) {
    flex: 1 1 auto;
    min-height: 0;
    border: none;
  }

  .session-picker {
    flex: 1;
    display: flex;
    flex-direction: column;
    gap: 0.45rem;
    padding: 0.85rem;
    min-height: 0;
    background: var(--bg-panel, #12151c);
  }

  .picker-title {
    font-size: 0.8rem;
    font-weight: 600;
    color: var(--text, #e8eaed);
  }

  .picker-input {
    box-sizing: border-box;
    width: 100%;
    border: 1px solid var(--border, #232833);
    border-radius: 7px;
    background: var(--bg-elevated, #161a22);
    color: var(--text, #e8eaed);
    font: inherit;
    font-size: 0.85rem;
    padding: 0.4rem 0.55rem;
    outline: none;
  }

  .picker-input:focus {
    border-color: var(--accent, #4c8dff);
  }

  .picker-list {
    list-style: none;
    margin: 0;
    padding: 0.2rem;
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    border: 1px solid var(--border, #232833);
    border-radius: 8px;
  }

  .picker-item {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.5rem;
    width: 100%;
    text-align: left;
    border: none;
    border-radius: 6px;
    background: transparent;
    color: var(--text, #e8eaed);
    font: inherit;
    font-size: 0.85rem;
    padding: 0.4rem 0.5rem;
    cursor: pointer;
  }

  .picker-item:hover,
  .picker-item.highlight {
    background: color-mix(in srgb, var(--accent, #4c8dff) 16%, transparent);
  }

  .picker-hint {
    margin: 0;
    font-size: 0.7rem;
  }

  .picker-cancel {
    border: 1px solid var(--border, #232833);
    border-radius: 7px;
    background: transparent;
    color: var(--muted, #8b93a7);
    font: inherit;
    font-size: 0.75rem;
    padding: 0.35rem 0.5rem;
    cursor: pointer;
    align-self: flex-start;
  }

  .picker-cancel:hover {
    color: var(--text, #e8eaed);
    border-color: var(--accent, #4c8dff);
  }

  .empty-pick {
    padding: 0.6rem;
    font-size: 0.8rem;
  }

  .drop-zone {
    pointer-events: none;
    position: absolute;
    z-index: 20;
    background: color-mix(in srgb, var(--accent, #4c8dff) 28%, transparent);
    border: 2px solid var(--accent, #4c8dff);
    border-radius: 4px;
  }

  .drop-zone[data-edge="center"] {
    inset: 18%;
  }

  .drop-zone[data-edge="left"] {
    top: 0;
    bottom: 0;
    left: 0;
    width: 28%;
  }

  .drop-zone[data-edge="right"] {
    top: 0;
    bottom: 0;
    right: 0;
    width: 28%;
  }

  .drop-zone[data-edge="up"] {
    top: 0;
    left: 0;
    right: 0;
    height: 28%;
  }

  .drop-zone[data-edge="down"] {
    bottom: 0;
    left: 0;
    right: 0;
    height: 28%;
  }

  .pane-drag-ghost {
    position: fixed;
    z-index: 10000;
    pointer-events: none;
    padding: 0.35rem 0.65rem;
    border-radius: 8px;
    background: var(--bg-elevated, #161a22);
    border: 1px solid var(--accent, #4c8dff);
    color: var(--text, #e8eaed);
    font-size: 0.8rem;
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.45);
    display: flex;
    align-items: center;
    gap: 0.45rem;
  }

  .ghost-edge {
    font-size: 0.7rem;
  }

  .pane-ctx {
    position: fixed;
    z-index: 9999;
    min-width: 11rem;
    padding: 0.3rem;
    border-radius: 10px;
    border: 1px solid var(--border, #232833);
    background: var(--bg-elevated, #161a22);
    box-shadow: 0 12px 32px rgba(0, 0, 0, 0.45);
    display: flex;
    flex-direction: column;
    gap: 0.1rem;
  }

  .ctx-item {
    text-align: left;
    border: none;
    border-radius: 7px;
    background: transparent;
    color: var(--text, #e8eaed);
    font: inherit;
    font-size: 0.82rem;
    padding: 0.4rem 0.55rem;
    cursor: pointer;
  }

  .ctx-item:hover {
    background: color-mix(in srgb, var(--accent, #4c8dff) 16%, transparent);
  }

  .muted {
    color: var(--muted, #8b93a7);
  }

  .mono {
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  }

  :global(body.pane-dragging) {
    cursor: grabbing !important;
    user-select: none !important;
  }
</style>
