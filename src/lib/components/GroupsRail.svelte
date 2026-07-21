<script lang="ts">
  import type { Group, SessionInfo, Conversation } from "$lib/types";
  import { GROUP_COLORS, groupMonogram } from "$lib/types";

  interface Props {
    groups: Group[];
    activeId: string;
    /** Keyboard highlight (may differ from active until Enter). */
    selectedId?: string | null;
    focused?: boolean;
    conversations: Conversation[];
    sessions: SessionInfo[];
    creating?: boolean;
    onSelect?: (id: string) => void;
    onHighlight?: (id: string) => void;
    onFocusRegion?: () => void;
    onCreate?: () => void;
    onDelete?: (id: string) => void | Promise<void>;
    /** Starts rename on the group title in the conversations header (not on the monogram). */
    onBeginRename?: (id: string) => void;
    onSetColor?: (id: string, color: string) => void;
    onReorder?: (id: string, toIndex: number) => void;
    onMove?: (id: string, delta: -1 | 1) => void;
  }

  let {
    groups,
    activeId,
    selectedId = null,
    focused = false,
    conversations,
    sessions,
    creating = false,
    onSelect,
    onHighlight,
    onFocusRegion,
    onCreate,
    onDelete,
    onBeginRename,
    onSetColor,
    onReorder,
    onMove,
  }: Props = $props();

  type MenuState = { groupId: string; x: number; y: number } | null;
  let menu = $state<MenuState>(null);
  let colorPickerFor = $state<string | null>(null);

  let dragId = $state<string | null>(null);
  let dropInsertAt = $state<number | null>(null);

  const highlightId = $derived(selectedId ?? activeId);

  function beginRename(id: string) {
    closeMenu();
    onBeginRename?.(id);
  }

  function hasBusy(groupId: string): boolean {
    const convoIds = new Set(
      conversations.filter((c) => c.groupId === groupId).map((c) => c.id),
    );
    return sessions.some(
      (s) =>
        convoIds.has(s.conversationId) &&
        (s.activity === "busy" || s.activity === "tui" || !!s.tuiActive),
    );
  }

  function closeMenu() {
    menu = null;
    colorPickerFor = null;
  }

  function openMenu(e: MouseEvent, groupId: string) {
    e.preventDefault();
    e.stopPropagation();
    menu = { groupId, x: e.clientX, y: e.clientY };
    colorPickerFor = null;
  }

  function menuGroup(): Group | null {
    if (!menu) return null;
    return groups.find((g) => g.id === menu!.groupId) ?? null;
  }

  function insertIndexForRow(e: DragEvent, targetId: string): number {
    const idx = groups.findIndex((g) => g.id === targetId);
    if (idx < 0) return groups.length;
    const el = e.currentTarget as HTMLElement | null;
    if (!el) return idx;
    const rect = el.getBoundingClientRect();
    const mid = rect.top + rect.height / 2;
    return e.clientY < mid ? idx : idx + 1;
  }

  function onDragStart(e: DragEvent, id: string) {
    dragId = id;
    dropInsertAt = null;
    e.dataTransfer?.setData("text/plain", id);
    if (e.dataTransfer) e.dataTransfer.effectAllowed = "move";
  }

  function onDragOverRow(e: DragEvent, targetId: string) {
    e.preventDefault();
    e.stopPropagation();
    if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
    dropInsertAt = insertIndexForRow(e, targetId);
  }

  function onDragOverEnd(e: DragEvent) {
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
    dropInsertAt = groups.length;
  }

  function onDragLeaveList(e: DragEvent) {
    const related = e.relatedTarget as Node | null;
    const list = e.currentTarget as HTMLElement;
    if (related && list.contains(related)) return;
    dropInsertAt = null;
  }

  function commitDrop(e: DragEvent) {
    e.preventDefault();
    e.stopPropagation();
    const sourceId = dragId ?? e.dataTransfer?.getData("text/plain") ?? null;
    const insertAt = dropInsertAt;
    dragId = null;
    dropInsertAt = null;
    if (!sourceId || insertAt == null) return;
    const from = groups.findIndex((g) => g.id === sourceId);
    if (from < 0) return;
    let to = insertAt;
    if (from < insertAt) to = insertAt - 1;
    if (to === from) return;
    onReorder?.(sourceId, to);
  }

  function onDragEnd() {
    dragId = null;
    dropInsertAt = null;
  }

  function showDropLine(i: number): boolean {
    return dragId != null && dropInsertAt === i;
  }
</script>

<svelte:window
  onclick={() => closeMenu()}
  onkeydown={(e) => {
    if (e.key === "Escape") closeMenu();
  }}
/>

<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
<aside
  class="groups-rail"
  class:region-focused={focused}
  aria-label="Groups"
  data-focus-region="groups"
  tabindex="0"
  onfocus={() => onFocusRegion?.()}
>
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <ul
    class="list"
    class:is-dragging={dragId != null}
    role="listbox"
    aria-label="Groups"
    ondragleave={onDragLeaveList}
    ondrop={commitDrop}
  >
    {#each groups as g, i (g.id)}
      {@const busy = hasBusy(g.id)}
      {@const isSelected = highlightId === g.id}
      {#if showDropLine(i)}
        <li class="drop-line" aria-hidden="true"></li>
      {/if}
      <li
        class:dragging={dragId === g.id}
        draggable={true}
        ondragstart={(e) => onDragStart(e, g.id)}
        ondragover={(e) => onDragOverRow(e, g.id)}
        ondrop={commitDrop}
        ondragend={onDragEnd}
      >
        <div class="group-wrap" class:selected={isSelected} class:active={g.id === activeId}>
          <button
            type="button"
            class="group-btn"
            class:active={g.id === activeId}
            class:selected={isSelected}
            class:busy
            style:--group-color={g.color}
            role="option"
            aria-selected={isSelected}
            tabindex="-1"
            title={g.name}
            onclick={() => {
              onHighlight?.(g.id);
              onSelect?.(g.id);
            }}
            oncontextmenu={(e) => openMenu(e, g.id)}
          >
            <span class="mono-circle">{groupMonogram(g.name)}</span>
            {#if busy}
              <span class="busy-pip" aria-hidden="true"></span>
            {/if}
          </button>
        </div>
      </li>
    {/each}
    {#if showDropLine(groups.length)}
      <li class="drop-line" aria-hidden="true"></li>
    {/if}
    <li
      class="drop-tail"
      class:active={dragId != null && dropInsertAt === groups.length}
      aria-hidden="true"
      ondragover={onDragOverEnd}
      ondrop={commitDrop}
    ></li>
  </ul>

  <button
    type="button"
    class="add-btn"
    tabindex="-1"
    title="New group (Alt+N when groups focused)"
    disabled={creating}
    onclick={() => onCreate?.()}
  >
    {creating ? "…" : "+"}
  </button>
</aside>

{#if menu}
  {@const mg = menuGroup()}
  {#if mg}
    {@const idx = groups.findIndex((g) => g.id === mg.id)}
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <!-- svelte-ignore a11y_click_events_have_key_events -->
    <!-- svelte-ignore a11y_interactive_supports_focus -->
    <div
      class="ctx-menu"
      style:left={`${Math.min(menu.x, window.innerWidth - 180)}px`}
      style:top={`${Math.min(menu.y, window.innerHeight - 260)}px`}
      role="menu"
      tabindex="-1"
      onclick={(e) => e.stopPropagation()}
    >
      <button
        type="button"
        class="ctx-item"
        role="menuitem"
        onclick={() => {
          onHighlight?.(mg.id);
          onSelect?.(mg.id);
          closeMenu();
        }}
      >
        Open
      </button>
      <button
        type="button"
        class="ctx-item"
        role="menuitem"
        onclick={() => beginRename(mg.id)}
      >
        Rename
      </button>
      <button
        type="button"
        class="ctx-item"
        role="menuitem"
        onclick={() => {
          colorPickerFor = colorPickerFor === mg.id ? null : mg.id;
        }}
      >
        Color…
      </button>
      {#if colorPickerFor === mg.id}
        <div class="color-row">
          {#each GROUP_COLORS as col}
            <button
              type="button"
              class="swatch"
              class:selected={mg.color === col}
              style:background={col}
              title={col}
              onclick={() => {
                onSetColor?.(mg.id, col);
                closeMenu();
              }}
            ></button>
          {/each}
        </div>
      {/if}
      <button
        type="button"
        class="ctx-item"
        role="menuitem"
        disabled={idx <= 0}
        onclick={() => {
          onMove?.(mg.id, -1);
          closeMenu();
        }}
      >
        Move up
      </button>
      <button
        type="button"
        class="ctx-item"
        role="menuitem"
        disabled={idx < 0 || idx >= groups.length - 1}
        onclick={() => {
          onMove?.(mg.id, 1);
          closeMenu();
        }}
      >
        Move down
      </button>
      <button
        type="button"
        class="ctx-item danger"
        role="menuitem"
        onclick={() => {
          void onDelete?.(mg.id);
          closeMenu();
        }}
      >
        Delete…
      </button>
    </div>
  {/if}
{/if}

<style>
  .groups-rail {
    box-sizing: border-box;
    width: 100%;
    height: 100%;
    max-height: 100%;
    min-height: 0;
    display: flex;
    flex-direction: column;
    align-items: center;
    background: color-mix(in srgb, var(--bg-panel, #12151c) 92%, #000);
    border-right: 1px solid var(--border, #232833);
    padding: 0.45rem 0 0.55rem;
    gap: 0.35rem;
    outline: none;
  }

  .groups-rail.region-focused {
    box-shadow: inset 2px 0 0 0 var(--accent, #4c8dff);
  }

  .group-wrap {
    position: relative;
    display: flex;
    flex-direction: column;
    align-items: center;
  }

  .group-btn.selected .mono-circle {
    box-shadow: 0 0 0 2px color-mix(in srgb, var(--group-color, #4c8dff) 70%, #fff);
  }

  .list {
    list-style: none;
    margin: 0;
    padding: 0;
    flex: 1 1 0;
    min-height: 0;
    width: 100%;
    overflow-y: auto;
    overflow-x: hidden;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 0.15rem;
  }

  .list li {
    margin: 0;
    padding: 0;
    width: 100%;
    display: flex;
    justify-content: center;
  }

  .list li.dragging {
    opacity: 0.4;
  }

  .drop-line {
    height: 0;
    width: 28px;
    border-top: 2px solid var(--accent, #4c8dff);
    margin: 0.1rem 0;
    pointer-events: none;
    box-shadow: 0 0 6px color-mix(in srgb, var(--accent, #4c8dff) 50%, transparent);
  }

  .drop-tail {
    flex: 1 1 auto;
    min-height: 1.25rem;
    width: 100%;
  }

  .drop-tail.active {
    box-shadow: inset 0 2px 0 0 var(--accent, #4c8dff);
  }

  .group-btn {
    position: relative;
    width: 2.35rem;
    height: 2.35rem;
    padding: 0;
    border: none;
    background: transparent;
    cursor: pointer;
    border-radius: 50%;
    display: inline-flex;
    align-items: center;
    justify-content: center;
  }

  .mono-circle {
    width: 2.1rem;
    height: 2.1rem;
    border-radius: 50%;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    font-size: 0.85rem;
    font-weight: 700;
    letter-spacing: 0.02em;
    color: #0f1115;
    background: var(--group-color, #4c8dff);
    border: 2px solid transparent;
    box-shadow: 0 0 0 0 transparent;
    transition:
      box-shadow 0.12s ease,
      border-color 0.12s ease,
      transform 0.1s ease;
  }

  .group-btn:hover .mono-circle {
    transform: scale(1.05);
  }

  .group-btn.active .mono-circle {
    border-color: #fff;
    box-shadow:
      0 0 0 2px var(--group-color, #4c8dff),
      0 0 12px color-mix(in srgb, var(--group-color, #4c8dff) 45%, transparent);
  }

  .busy-pip {
    position: absolute;
    right: 0.05rem;
    bottom: 0.05rem;
    width: 0.45rem;
    height: 0.45rem;
    border-radius: 50%;
    background: var(--idle, #f0b429);
    box-shadow: 0 0 5px color-mix(in srgb, var(--idle, #f0b429) 60%, transparent);
    border: 1px solid var(--bg-panel, #12151c);
  }

  .add-btn {
    flex-shrink: 0;
    width: 2.1rem;
    height: 2.1rem;
    border-radius: 50%;
    border: 1px dashed var(--border, #232833);
    background: transparent;
    color: var(--muted, #8b93a7);
    font-size: 1.15rem;
    line-height: 1;
    cursor: pointer;
    display: inline-flex;
    align-items: center;
    justify-content: center;
  }

  .add-btn:hover:not(:disabled) {
    border-color: var(--accent, #4c8dff);
    color: var(--accent, #4c8dff);
  }

  .add-btn:disabled {
    opacity: 0.5;
    cursor: default;
  }

  .ctx-menu {
    position: fixed;
    z-index: 80;
    min-width: 9.5rem;
    padding: 0.3rem;
    border-radius: 8px;
    border: 1px solid var(--border, #232833);
    background: var(--bg-elevated, #161a22);
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.45);
    display: flex;
    flex-direction: column;
    gap: 0.1rem;
  }

  .ctx-item {
    display: flex;
    width: 100%;
    padding: 0.45rem 0.6rem;
    border: none;
    border-radius: 6px;
    background: transparent;
    color: var(--text, #e8eaed);
    font: inherit;
    font-size: 0.85rem;
    cursor: pointer;
    text-align: left;
  }

  .ctx-item:hover:not(:disabled) {
    background: color-mix(in srgb, var(--accent, #4c8dff) 16%, transparent);
  }

  .ctx-item:disabled {
    opacity: 0.4;
    cursor: default;
  }

  .ctx-item.danger {
    color: var(--danger, #e35d6a);
  }

  .color-row {
    display: grid;
    grid-template-columns: repeat(4, 1fr);
    gap: 0.3rem;
    padding: 0.35rem 0.4rem 0.45rem;
  }

  .swatch {
    width: 1.25rem;
    height: 1.25rem;
    border-radius: 50%;
    border: 2px solid transparent;
    cursor: pointer;
    padding: 0;
  }

  .swatch.selected {
    border-color: #fff;
    box-shadow: 0 0 0 1px rgba(0, 0, 0, 0.4);
  }
</style>
