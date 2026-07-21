<script lang="ts">
  import type { Conversation, SessionInfo } from "$lib/types";

  interface Props {
    /** Active group display name (header title). */
    groupName?: string;
    /** When true, header shows group rename input. */
    groupRenameActive?: boolean;
    conversations: Conversation[];
    activeId: string;
    selectedId?: string | null;
    focused?: boolean;
    sessions: SessionInfo[];
    creating?: boolean;
    renameTargetId?: string | null;
    onSelect?: (id: string) => void;
    onHighlight?: (id: string) => void;
    onFocusRegion?: () => void;
    onCreate?: () => void;
    onDelete?: (id: string) => void | Promise<void>;
    onRename?: (id: string, name: string) => void | Promise<void>;
    onBeginRename?: (id: string) => void;
    onCancelRename?: () => void;
    onRenameGroup?: (name: string) => void | Promise<void>;
    onBeginGroupRename?: () => void;
    onCancelGroupRename?: () => void;
    onReorder?: (id: string, toIndex: number) => void;
    onMove?: (id: string, delta: -1 | 1) => void;
  }

  let {
    groupName = "Home",
    groupRenameActive = false,
    conversations,
    activeId,
    selectedId = null,
    focused = false,
    sessions,
    creating = false,
    renameTargetId = null,
    onSelect,
    onHighlight,
    onFocusRegion,
    onCreate,
    onDelete,
    onRename,
    onBeginRename,
    onCancelRename,
    onRenameGroup,
    onBeginGroupRename,
    onCancelGroupRename,
    onReorder,
    onMove,
  }: Props = $props();

  let editValue = $state("");
  let renameError = $state<string | null>(null);
  let renaming = $state(false);
  let inputEl: HTMLInputElement | undefined = $state();

  let groupEditValue = $state("");
  let groupRenameError = $state<string | null>(null);
  let groupRenaming = $state(false);
  let groupInputEl: HTMLInputElement | undefined = $state();

  const highlightId = $derived(selectedId ?? activeId);

  type MenuState = { conversationId: string; x: number; y: number } | null;
  let menu = $state<MenuState>(null);

  /** Drag source id while reordering. */
  let dragId = $state<string | null>(null);
  /**
   * Drop indicator: index in the current list where the item would be inserted
   * (0 = before first, length = after last). Null when not dragging over a target.
   */
  let dropInsertAt = $state<number | null>(null);

  const editingId = $derived(renameTargetId);

  $effect(() => {
    const id = renameTargetId;
    if (!id) {
      editValue = "";
      renameError = null;
      renaming = false;
      return;
    }
    const c = conversations.find((x) => x.id === id);
    editValue = c?.name ?? "";
    renameError = null;
    renaming = false;
    requestAnimationFrame(() => {
      inputEl?.focus();
      inputEl?.select();
    });
  });

  $effect(() => {
    if (!groupRenameActive) {
      groupEditValue = "";
      groupRenameError = null;
      groupRenaming = false;
      return;
    }
    groupEditValue = groupName;
    groupRenameError = null;
    groupRenaming = false;
    requestAnimationFrame(() => {
      groupInputEl?.focus();
      groupInputEl?.select();
    });
  });

  function cancelGroupRename() {
    onCancelGroupRename?.();
    groupRenameError = null;
    groupRenaming = false;
  }

  async function commitGroupRename() {
    if (groupRenaming || !groupRenameActive) return;
    const next = groupEditValue.trim();
    if (!next) {
      groupRenameError = "Name required";
      return;
    }
    if (next.toLowerCase() === groupName.toLowerCase()) {
      cancelGroupRename();
      return;
    }
    groupRenaming = true;
    groupRenameError = null;
    try {
      await onRenameGroup?.(next);
      cancelGroupRename();
    } catch (err) {
      groupRenameError = String(err).replace(/^Error:\s*/, "");
      groupRenaming = false;
      requestAnimationFrame(() => groupInputEl?.focus());
    }
  }

  function onGroupEditKeydown(e: KeyboardEvent) {
    if (e.key === "Enter") {
      e.preventDefault();
      e.stopPropagation();
      void commitGroupRename();
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      cancelGroupRename();
    }
  }

  function sessionCount(convoId: string): number {
    return sessions.filter((s) => s.conversationId === convoId).length;
  }

  function hasBusy(convoId: string): boolean {
    return sessions.some(
      (s) =>
        s.conversationId === convoId &&
        (s.activity === "busy" || s.activity === "tui" || !!s.tuiActive),
    );
  }

  function closeMenu() {
    menu = null;
  }

  function openMenu(e: MouseEvent, conversationId: string) {
    e.preventDefault();
    e.stopPropagation();
    menu = { conversationId, x: e.clientX, y: e.clientY };
  }

  function beginRename(id: string) {
    closeMenu();
    onBeginRename?.(id);
  }

  function cancelRename() {
    onCancelRename?.();
    renameError = null;
    renaming = false;
  }

  async function commitRename(conversationId: string) {
    if (renaming) return;
    if (editingId !== conversationId) return;
    const convo = conversations.find((c) => c.id === conversationId);
    if (!convo) {
      cancelRename();
      return;
    }
    const next = editValue.trim();
    if (!next) {
      renameError = "Name required";
      return;
    }
    if (next.toLowerCase() === convo.name.toLowerCase()) {
      cancelRename();
      return;
    }
    renaming = true;
    renameError = null;
    try {
      await onRename?.(conversationId, next);
      cancelRename();
    } catch (err) {
      renameError = String(err).replace(/^Error:\s*/, "");
      renaming = false;
      requestAnimationFrame(() => inputEl?.focus());
    }
  }

  function onEditKeydown(e: KeyboardEvent, conversationId: string) {
    if (e.key === "Enter") {
      e.preventDefault();
      e.stopPropagation();
      void commitRename(conversationId);
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      cancelRename();
    }
  }

  function menuConvo(): Conversation | null {
    if (!menu) return null;
    return conversations.find((c) => c.id === menu!.conversationId) ?? null;
  }

  function onDragStart(e: DragEvent, id: string) {
    if (editingId) {
      e.preventDefault();
      return;
    }
    dragId = id;
    dropInsertAt = null;
    e.dataTransfer?.setData("text/plain", id);
    if (e.dataTransfer) e.dataTransfer.effectAllowed = "move";
  }

  /**
   * Upper half of a row → insert before it; lower half → insert after.
   * That makes “drag to last” work by dropping on the bottom half of the last row.
   */
  function insertIndexForRow(e: DragEvent, targetId: string): number {
    const idx = conversations.findIndex((c) => c.id === targetId);
    if (idx < 0) return conversations.length;
    const el = e.currentTarget as HTMLElement | null;
    if (!el) return idx;
    const rect = el.getBoundingClientRect();
    const mid = rect.top + rect.height / 2;
    return e.clientY < mid ? idx : idx + 1;
  }

  function onDragOverRow(e: DragEvent, targetId: string) {
    e.preventDefault();
    e.stopPropagation();
    if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
    if (!dragId || dragId === targetId) {
      // Still allow computing insert around self for end-of-list feel when needed.
    }
    dropInsertAt = insertIndexForRow(e, targetId);
  }

  function onDragOverEnd(e: DragEvent) {
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
    dropInsertAt = conversations.length;
  }

  function onDragLeaveList(e: DragEvent) {
    // Only clear when leaving the list entirely (not entering a child).
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

    const from = conversations.findIndex((c) => c.id === sourceId);
    if (from < 0) return;

    // Convert “insert before index insertAt in current list” → final index after removal.
    let to = insertAt;
    if (from < insertAt) to = insertAt - 1;
    if (to === from) return;
    onReorder?.(sourceId, to);
  }

  function onDragEnd() {
    dragId = null;
    dropInsertAt = null;
  }

  /** Line shown before item i, or after the last item when i === length. */
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
  class="conversations-rail"
  class:region-focused={focused}
  aria-label="Conversations"
  data-focus-region="conversations"
  tabindex="0"
  onfocus={() => onFocusRegion?.()}
>
  <div class="pane-header">
    {#if groupRenameActive}
      <div class="group-rename-wrap">
        <input
          bind:this={groupInputEl}
          class="group-rename-input"
          bind:value={groupEditValue}
          disabled={groupRenaming}
          maxlength={32}
          spellcheck="false"
          aria-label="Group name"
          onkeydown={onGroupEditKeydown}
          onblur={() => void commitGroupRename()}
        />
        {#if groupRenameError}
          <span class="group-rename-error" title={groupRenameError}>!</span>
        {/if}
      </div>
    {:else}
      <div class="group-title-row">
        <button
          type="button"
          class="group-title"
          title={`${groupName} — double-click or use pencil to rename`}
          tabindex="-1"
          ondblclick={() => onBeginGroupRename?.()}
        >
          {groupName}
        </button>
        <button
          type="button"
          class="icon-btn pencil"
          tabindex="-1"
          title="Rename group (Alt+R when groups focused)"
          aria-label={`Rename group ${groupName}`}
          onclick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            onBeginGroupRename?.();
          }}
        >
          <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <path
              d="M11.5 1.5l3 3L5 14H2v-3L11.5 1.5z"
              stroke="currentColor"
              stroke-width="1.4"
              stroke-linejoin="round"
            />
          </svg>
        </button>
      </div>
    {/if}
    <button
      type="button"
      class="add-btn"
      tabindex="-1"
      title="New conversation (Alt+N when conversations focused)"
      disabled={creating}
      onclick={() => onCreate?.()}
    >
      {creating ? "…" : "+"}
    </button>
  </div>
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <ul
    class="list"
    class:is-dragging={dragId != null}
    role="listbox"
    aria-label="Conversations"
    ondragleave={onDragLeaveList}
    ondrop={commitDrop}
  >
    {#each conversations as c, i (c.id)}
      {@const count = sessionCount(c.id)}
      {@const busy = hasBusy(c.id)}
      {@const isEditing = editingId === c.id}
      {@const isSelected = highlightId === c.id}
      {#if showDropLine(i)}
        <li class="drop-line" aria-hidden="true"></li>
      {/if}
      <li
        class:dragging={dragId === c.id}
        draggable={!isEditing}
        ondragstart={(e) => onDragStart(e, c.id)}
        ondragover={(e) => onDragOverRow(e, c.id)}
        ondrop={commitDrop}
        ondragend={onDragEnd}
      >
        {#if isEditing}
          <div class="rename-row">
            <input
              bind:this={inputEl}
              class="rename-input"
              bind:value={editValue}
              disabled={renaming}
              maxlength={48}
              spellcheck="false"
              aria-label="Conversation name"
              onkeydown={(e) => onEditKeydown(e, c.id)}
              onblur={() => void commitRename(c.id)}
            />
          </div>
          {#if renameError}
            <div class="rename-error">{renameError}</div>
          {/if}
        {:else}
          <!-- svelte-ignore a11y_no_static_element_interactions -->
          <!-- svelte-ignore a11y_interactive_supports_focus -->
          <div
            class="rail-row"
            class:active={c.id === activeId}
            class:selected={isSelected}
            class:busy
            role="option"
            aria-selected={isSelected}
            tabindex="-1"
            oncontextmenu={(e) => openMenu(e, c.id)}
          >
            <button
              type="button"
              class="rail-main"
              tabindex="-1"
              onclick={() => {
                onHighlight?.(c.id);
                onSelect?.(c.id);
              }}
              title={busy
                ? `${c.name} · work running in background`
                : `${c.name} · drag to reorder`}
            >
              <span class="grip" aria-hidden="true" title="Drag to reorder">⋮⋮</span>
              <span class="meta">
                <span class="name">{c.name}</span>
                {#if busy}
                  <span class="last mono">busy</span>
                {/if}
              </span>
              <span class="muted sm" class:accent={busy}>
                {#if busy}
                  <span class="dot busy-dot" aria-hidden="true"></span>
                {/if}
                {count}
              </span>
            </button>
            <div class="row-actions">
              <button
                type="button"
                class="icon-btn"
                tabindex="-1"
                title="Rename (Alt+R)"
                aria-label={`Rename ${c.name}`}
                onclick={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  onHighlight?.(c.id);
                  beginRename(c.id);
                }}
              >
                <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                  <path
                    d="M11.5 1.5l3 3L5 14H2v-3L11.5 1.5z"
                    stroke="currentColor"
                    stroke-width="1.4"
                    stroke-linejoin="round"
                  />
                </svg>
              </button>
            </div>
          </div>
        {/if}
      </li>
    {/each}
    {#if showDropLine(conversations.length)}
      <li class="drop-line" aria-hidden="true"></li>
    {/if}
    <!-- Tall hit target so dropping past the last row always means “move to end” -->
    <li
      class="drop-tail"
      class:active={dragId != null && dropInsertAt === conversations.length}
      aria-hidden="true"
      ondragover={onDragOverEnd}
      ondrop={commitDrop}
    ></li>
  </ul>
</aside>

{#if menu}
  {@const mc = menuConvo()}
  {#if mc}
    {@const idx = conversations.findIndex((c) => c.id === mc.id)}
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <!-- svelte-ignore a11y_click_events_have_key_events -->
    <!-- svelte-ignore a11y_interactive_supports_focus -->
    <div
      class="ctx-menu"
      style:left={`${Math.min(menu.x, window.innerWidth - 200)}px`}
      style:top={`${Math.min(menu.y, window.innerHeight - 200)}px`}
      role="menu"
      tabindex="-1"
      onclick={(e) => e.stopPropagation()}
    >
      <button
        type="button"
        class="ctx-item"
        role="menuitem"
        onclick={() => {
          onSelect?.(mc.id);
          closeMenu();
        }}
      >
        Open
      </button>
      <button
        type="button"
        class="ctx-item"
        role="menuitem"
        onclick={() => beginRename(mc.id)}
      >
        Rename
      </button>
      <button
        type="button"
        class="ctx-item"
        role="menuitem"
        disabled={idx <= 0}
        onclick={() => {
          onMove?.(mc.id, -1);
          closeMenu();
        }}
      >
        Move up
      </button>
      <button
        type="button"
        class="ctx-item"
        role="menuitem"
        disabled={idx < 0 || idx >= conversations.length - 1}
        onclick={() => {
          onMove?.(mc.id, 1);
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
          void onDelete?.(mc.id);
          closeMenu();
        }}
      >
        Delete…
      </button>
    </div>
  {/if}
{/if}

<style>
  .conversations-rail {
    box-sizing: border-box;
    width: 100%;
    min-width: 0;
    height: 100%;
    max-height: 100%;
    background: var(--bg-panel, #12151c);
    border-right: 1px solid var(--border, #232833);
    color: var(--text, #e8eaed);
    min-height: 0;
    overflow: hidden;
    display: flex;
    flex-direction: column;
    outline: none;
  }

  .conversations-rail.region-focused {
    box-shadow: inset 2px 0 0 0 var(--accent, #4c8dff);
  }

  .pane-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.5rem;
    padding: 0.75rem 0.85rem;
    border-bottom: 1px solid var(--border, #232833);
    font-size: 0.9rem;
    color: var(--muted, #8b93a7);
    flex-shrink: 0;
  }

  .group-title-row {
    flex: 1 1 0;
    min-width: 0;
    display: flex;
    align-items: center;
    gap: 0.35rem;
  }

  .group-title {
    min-width: 0;
    max-width: 100%;
    margin: 0;
    padding: 0;
    border: none;
    background: transparent;
    font: inherit;
    font-weight: 600;
    font-size: 0.95rem;
    color: var(--text, #e8eaed);
    text-align: left;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    cursor: default;
  }

  .group-title-row .pencil {
    flex: 0 0 auto;
    opacity: 0.55;
    width: 1.35rem;
    height: 1.35rem;
    border-radius: 6px;
    border: 1px solid transparent;
    background: transparent;
    color: var(--muted, #8b93a7);
    padding: 0;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    cursor: pointer;
  }

  .group-title-row:hover .pencil,
  .region-focused .group-title-row .pencil {
    opacity: 1;
  }

  .group-title-row .pencil:hover {
    color: var(--accent, #4c8dff);
    border-color: var(--border, #232833);
    background: var(--bg-elevated, #161a22);
  }

  .group-rename-wrap {
    flex: 1 1 0;
    min-width: 0;
    display: flex;
    align-items: center;
    gap: 0.35rem;
  }

  .group-rename-input {
    flex: 1 1 0;
    min-width: 0;
    box-sizing: border-box;
    padding: 0.25rem 0.4rem;
    border-radius: 6px;
    border: 1px solid var(--accent, #4c8dff);
    background: var(--bg-elevated, #161a22);
    color: var(--text, #e8eaed);
    font: inherit;
    font-weight: 600;
    font-size: 0.95rem;
  }

  .group-rename-error {
    color: var(--danger, #e35d6a);
    font-size: 0.8rem;
    font-weight: 700;
  }

  .add-btn {
    width: 1.55rem;
    height: 1.55rem;
    border-radius: 6px;
    border: 1px solid var(--border, #232833);
    background: var(--bg-elevated, #161a22);
    color: var(--text, #e8eaed);
    font-size: 1.05rem;
    line-height: 1;
    cursor: pointer;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    padding: 0;
  }

  .add-btn:hover:not(:disabled) {
    border-color: var(--accent, #4c8dff);
    color: var(--accent, #4c8dff);
  }

  .add-btn:disabled {
    opacity: 0.5;
    cursor: default;
  }

  .list {
    list-style: none;
    margin: 0;
    padding: 0.35rem 0;
    overflow-y: auto;
    flex: 1 1 0;
    min-height: 0;
    display: flex;
    flex-direction: column;
  }

  .list li {
    margin: 0;
    width: 100%;
  }

  /* Match SessionsRail row layout */
  .rail-row {
    display: flex;
    align-items: stretch;
    width: 100%;
    box-sizing: border-box;
  }

  .rail-row:hover {
    background: color-mix(in srgb, var(--accent, #4c8dff) 8%, transparent);
  }

  .rail-row.active {
    background: color-mix(in srgb, var(--accent, #4c8dff) 12%, transparent);
  }

  .rail-row.selected:not(.active) {
    outline: 1px solid color-mix(in srgb, var(--accent, #4c8dff) 45%, transparent);
    outline-offset: -1px;
  }

  .rail-row.busy {
    background: color-mix(in srgb, var(--idle, #f0b429) 10%, transparent);
  }

  .rail-main {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    flex: 1;
    min-width: 0;
    width: 100%;
    padding: 0.55rem 0.15rem 0.55rem 0.85rem;
    border: none;
    background: transparent;
    color: inherit;
    font: inherit;
    text-align: left;
    cursor: pointer;
  }

  .grip {
    flex-shrink: 0;
    font-size: 0.55rem;
    letter-spacing: -0.05em;
    color: var(--muted, #8b93a7);
    opacity: 0.55;
    cursor: grab;
    user-select: none;
    width: 0.9rem;
  }

  .meta {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 0.1rem;
  }

  .name {
    font-weight: 600;
    font-size: 0.9rem;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .last {
    font-size: 0.72rem;
    opacity: 0.85;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .muted {
    color: var(--muted, #8b93a7);
  }

  .sm {
    font-size: 0.75rem;
    flex-shrink: 0;
    padding-right: 0.25rem;
    display: inline-flex;
    align-items: center;
    gap: 0.3rem;
  }

  .sm.accent {
    color: var(--idle, #f0b429);
  }

  .mono {
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  }

  .dot {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    display: inline-block;
  }

  .busy-dot {
    background: var(--idle, #f0b429);
    box-shadow: 0 0 6px color-mix(in srgb, var(--idle, #f0b429) 55%, transparent);
  }

  .row-actions {
    display: flex;
    align-items: center;
    gap: 0.1rem;
    padding-right: 0.35rem;
    opacity: 0;
    transition: opacity 0.12s ease;
  }

  .rail-row:hover .row-actions,
  .rail-row.active .row-actions,
  .rail-row.selected .row-actions,
  .rail-row:focus-within .row-actions {
    opacity: 1;
  }

  .icon-btn {
    width: 1.55rem;
    height: 1.55rem;
    border: none;
    border-radius: 6px;
    background: transparent;
    color: var(--muted, #8b93a7);
    cursor: pointer;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    padding: 0;
  }

  .icon-btn:hover {
    background: color-mix(in srgb, var(--accent, #4c8dff) 16%, transparent);
    color: var(--text, #e8eaed);
  }

  .rename-row {
    display: flex;
    align-items: center;
    width: 100%;
    box-sizing: border-box;
    padding: 0.45rem 0.55rem 0.45rem 0.85rem;
  }

  .rename-input {
    flex: 1;
    min-width: 0;
    width: 100%;
    border: 1px solid var(--accent, #4c8dff);
    border-radius: 6px;
    background: var(--bg-elevated, #161a22);
    color: var(--text, #e8eaed);
    padding: 0.3rem 0.4rem;
    font-size: 0.85rem;
    outline: none;
  }

  .rename-error {
    padding: 0 0.85rem 0.35rem;
    font-size: 0.72rem;
    color: var(--danger, #e35d6a);
  }

  .list li.dragging {
    opacity: 0.45;
  }

  .list.is-dragging {
    min-height: 100%;
  }

  .drop-line {
    list-style: none;
    height: 0;
    margin: 0 0.55rem;
    padding: 0;
    border-top: 2px solid var(--accent, #4c8dff);
    border-radius: 1px;
    box-shadow: 0 0 6px color-mix(in srgb, var(--accent, #4c8dff) 50%, transparent);
    pointer-events: none;
  }

  .drop-tail {
    list-style: none;
    flex: 1 1 auto;
    min-height: 2.5rem;
    margin: 0;
    padding: 0;
  }

  .drop-tail.active {
    box-shadow: inset 0 2px 0 0 var(--accent, #4c8dff);
  }

  .ctx-menu {
    position: fixed;
    z-index: 80;
    min-width: 10rem;
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
    align-items: center;
    justify-content: flex-start;
    gap: 0.5rem;
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

  .ctx-item.danger:hover:not(:disabled) {
    background: color-mix(in srgb, var(--danger, #e35d6a) 14%, transparent);
  }
</style>
