<script lang="ts">
  import type { Conversation, SessionInfo } from "$lib/types";

  interface Props {
    /** Active group name shown in the header (click / double-click to rename). */
    groupName?: string;
    conversations: Conversation[];
    activeId: string;
    sessions: SessionInfo[];
    creating?: boolean;
    /** Conversation currently in rename mode. */
    renameTargetId?: string | null;
    onSelect?: (id: string) => void;
    onCreate?: () => void;
    onDelete?: (id: string) => void | Promise<void>;
    onRename?: (id: string, name: string) => void | Promise<void>;
    onBeginRename?: (id: string) => void;
    onCancelRename?: () => void;
    /** Rename the active group (header title). */
    onRenameGroup?: (name: string) => void | Promise<void>;
    onReorder?: (id: string, toIndex: number) => void;
    onMove?: (id: string, delta: -1 | 1) => void;
  }

  let {
    groupName = "Home",
    conversations,
    activeId,
    sessions,
    creating = false,
    renameTargetId = null,
    onSelect,
    onCreate,
    onDelete,
    onRename,
    onBeginRename,
    onCancelRename,
    onRenameGroup,
    onReorder,
    onMove,
  }: Props = $props();

  let editValue = $state("");
  let renameError = $state<string | null>(null);
  let renaming = $state(false);
  let inputEl: HTMLInputElement | undefined = $state();

  /** Inline edit of the group name in the pane header. */
  let editingGroup = $state(false);
  let groupEditValue = $state("");
  let groupRenameError = $state<string | null>(null);
  let groupRenaming = $state(false);
  let groupInputEl: HTMLInputElement | undefined = $state();

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
    cancelGroupRename();
    onBeginRename?.(id);
  }

  function cancelRename() {
    onCancelRename?.();
    renameError = null;
    renaming = false;
  }

  function beginGroupRename() {
    if (!onRenameGroup) return;
    closeMenu();
    onCancelRename?.();
    editingGroup = true;
    groupEditValue = groupName;
    groupRenameError = null;
    groupRenaming = false;
    requestAnimationFrame(() => {
      groupInputEl?.focus();
      groupInputEl?.select();
    });
  }

  function cancelGroupRename() {
    editingGroup = false;
    groupEditValue = "";
    groupRenameError = null;
    groupRenaming = false;
  }

  async function commitGroupRename() {
    if (groupRenaming || !editingGroup) return;
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

  // Keep header edit value in sync when group switches while not editing.
  $effect(() => {
    void groupName;
    if (!editingGroup) {
      groupEditValue = groupName;
      groupRenameError = null;
    }
  });

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

<aside class="conversations-rail" aria-label="Conversations">
  <div class="pane-header">
    {#if editingGroup}
      <div class="group-rename">
        <input
          bind:this={groupInputEl}
          class="group-rename-input"
          bind:value={groupEditValue}
          disabled={groupRenaming}
          maxlength={48}
          spellcheck="false"
          aria-label="Group name"
          onkeydown={onGroupEditKeydown}
          onblur={() => void commitGroupRename()}
        />
        {#if groupRenameError}
          <span class="group-rename-error">{groupRenameError}</span>
        {/if}
      </div>
    {:else}
      <button
        type="button"
        class="group-title"
        title={`${groupName} — click to rename`}
        onclick={beginGroupRename}
      >
        {groupName}
      </button>
    {/if}
    <button
      type="button"
      class="add-btn"
      title="New conversation"
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
    ondragleave={onDragLeaveList}
    ondrop={commitDrop}
  >
    {#each conversations as c, i (c.id)}
      {@const count = sessionCount(c.id)}
      {@const busy = hasBusy(c.id)}
      {@const isEditing = editingId === c.id}
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
          <button
            type="button"
            class="convo-row"
            class:active={c.id === activeId}
            class:busy
            onclick={() => onSelect?.(c.id)}
            oncontextmenu={(e) => openMenu(e, c.id)}
            ondblclick={() => beginRename(c.id)}
            title={busy
              ? `${c.name} · work running in background · drag to reorder`
              : `${c.name} · drag to reorder · double-click to rename`}
          >
            <span class="grip" aria-hidden="true" title="Drag to reorder">⋮⋮</span>
            <span class="name">{c.name}</span>
            <span class="meta">
              {#if busy}
                <span class="dot busy-dot" aria-hidden="true"></span>
              {/if}
              <span class="count muted">{count}</span>
            </span>
          </button>
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

  .group-title {
    flex: 1 1 0;
    min-width: 0;
    margin: 0;
    padding: 0.15rem 0.25rem;
    border: 1px solid transparent;
    border-radius: 6px;
    background: transparent;
    font: inherit;
    font-weight: 600;
    font-size: 0.95rem;
    color: var(--text, #e8eaed);
    text-align: left;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    cursor: text;
  }

  .group-title:hover {
    border-color: var(--border, #232833);
    background: var(--bg-elevated, #161a22);
  }

  .group-rename {
    flex: 1 1 0;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 0.15rem;
  }

  .group-rename-input {
    width: 100%;
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

  .group-rename-input:focus {
    outline: none;
    box-shadow: 0 0 0 2px color-mix(in srgb, var(--accent, #4c8dff) 35%, transparent);
  }

  .group-rename-error {
    font-size: 0.7rem;
    color: var(--danger, #e35d6a);
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
    padding: 0 0.35rem;
  }

  .list li.dragging {
    opacity: 0.45;
  }

  .list.is-dragging {
    /* Make empty space under the list a valid drop surface */
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

  .convo-row {
    width: 100%;
    display: flex;
    align-items: center;
    justify-content: flex-start;
    gap: 0.35rem;
    padding: 0.5rem 0.45rem;
    margin: 0.1rem 0;
    border: 1px solid transparent;
    border-radius: 8px;
    background: transparent;
    color: inherit;
    font: inherit;
    text-align: left;
    cursor: pointer;
  }

  .convo-row:hover {
    background: var(--bg-elevated, #161a22);
    border-color: var(--border, #232833);
  }

  .convo-row.active {
    background: color-mix(in srgb, var(--accent, #4c8dff) 14%, var(--bg-elevated, #161a22));
    border-color: color-mix(in srgb, var(--accent, #4c8dff) 40%, var(--border, #232833));
  }

  .convo-row.busy:not(.active) .name {
    color: var(--idle, #f0b429);
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

  .name {
    font-weight: 600;
    font-size: 0.9rem;
    min-width: 0;
    flex: 1 1 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .meta {
    display: inline-flex;
    align-items: center;
    gap: 0.35rem;
    flex-shrink: 0;
  }

  .count {
    font-size: 0.75rem;
    font-variant-numeric: tabular-nums;
  }

  .muted {
    color: var(--muted, #8b93a7);
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

  .rename-row {
    display: flex;
    align-items: center;
    padding: 0.25rem 0.15rem;
  }

  .rename-input {
    width: 100%;
    box-sizing: border-box;
    padding: 0.4rem 0.5rem;
    border-radius: 6px;
    border: 1px solid var(--accent, #4c8dff);
    background: var(--bg-elevated, #161a22);
    color: var(--text, #e8eaed);
    font: inherit;
    font-weight: 600;
    font-size: 0.9rem;
  }

  .rename-input:focus {
    outline: none;
    box-shadow: 0 0 0 2px color-mix(in srgb, var(--accent, #4c8dff) 35%, transparent);
  }

  .rename-error {
    padding: 0 0.5rem 0.35rem;
    font-size: 0.72rem;
    color: var(--danger, #e35d6a);
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
