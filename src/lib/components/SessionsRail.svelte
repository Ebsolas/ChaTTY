<script lang="ts">
  import { chordFor } from "$lib/stores";
  import type { SessionInfo } from "$lib/types";

  interface Props {
    sessions: SessionInfo[];
    activeId: string | null;
    expandedId?: string | null;
    canRemove?: boolean;
    creating?: boolean;
    /** Session currently in rename mode (controlled from parent for Alt+R). */
    renameTargetId?: string | null;
    onOpen?: (sessionId: string) => void;
    onCreate?: () => void;
    onClose?: (sessionId: string) => void;
    onRename?: (sessionId: string, name: string) => void | Promise<void>;
    onBeginRename?: (sessionId: string) => void;
    onCancelRename?: () => void;
  }

  let {
    sessions,
    activeId,
    expandedId = null,
    canRemove = true,
    creating = false,
    renameTargetId = null,
    onOpen,
    onCreate,
    onClose,
    onRename,
    onBeginRename,
    onCancelRename,
  }: Props = $props();

  let editValue = $state("");
  let renameError = $state<string | null>(null);
  let renaming = $state(false);
  let inputEl: HTMLInputElement | undefined = $state();

  type MenuState = {
    sessionId: string;
    x: number;
    y: number;
  } | null;
  let menu = $state<MenuState>(null);

  const editingId = $derived(renameTargetId);

  $effect(() => {
    const id = renameTargetId;
    if (!id) {
      editValue = "";
      renameError = null;
      renaming = false;
      return;
    }
    const s = sessions.find((x) => x.id === id);
    editValue = s?.name ?? "";
    renameError = null;
    renaming = false;
    requestAnimationFrame(() => {
      inputEl?.focus();
      inputEl?.select();
    });
  });

  function statusLabel(s: SessionInfo): string {
    if (s.starting || s.status === "starting") return "starting";
    if (s.activity === "tui" || s.tuiActive) return "tui";
    if (s.activity === "busy") return "busy";
    return s.status;
  }

  function statusTitle(s: SessionInfo, i: number): string {
    const key = i < 9 ? chordFor(`session${i + 1}` as "session1") : "";
    if (s.starting || s.status === "starting") {
      return `Starting shell…${key ? ` · ${key}` : ""}`;
    }
    if (s.activity === "tui" || s.tuiActive) {
      return `Interactive UI (TUI) · ${s.lastCommand ?? "app"}${key ? ` · ${key}` : ""}`;
    }
    if (s.activity === "busy" && s.lastCommand) {
      return `Running: ${s.lastCommand}${key ? ` · ${key}` : ""}`;
    }
    return `Open terminal${key ? ` (${key})` : ""}`;
  }

  function closeMenu() {
    menu = null;
  }

  function openMenu(e: MouseEvent, sessionId: string) {
    e.preventDefault();
    e.stopPropagation();
    menu = { sessionId, x: e.clientX, y: e.clientY };
  }

  function handleClose(e: MouseEvent, id: string) {
    e.preventDefault();
    e.stopPropagation();
    closeMenu();
    onClose?.(id);
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

  async function commitRename(sessionId: string) {
    if (renaming) return;
    if (editingId !== sessionId) return;
    const session = sessions.find((s) => s.id === sessionId);
    if (!session) {
      cancelRename();
      return;
    }
    const next = editValue.trim().replace(/^@+/, "");
    if (!next) {
      renameError = "Name required";
      return;
    }
    if (next.toLowerCase() === session.name.toLowerCase()) {
      cancelRename();
      return;
    }
    renaming = true;
    renameError = null;
    try {
      await onRename?.(sessionId, next);
      cancelRename();
    } catch (err) {
      renameError = String(err).replace(/^Error:\s*/, "");
      renaming = false;
      requestAnimationFrame(() => inputEl?.focus());
    }
  }

  function onEditKeydown(e: KeyboardEvent, sessionId: string) {
    if (e.key === "Enter") {
      e.preventDefault();
      e.stopPropagation();
      void commitRename(sessionId);
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      cancelRename();
    }
  }

  function menuSession(): SessionInfo | null {
    if (!menu) return null;
    return sessions.find((s) => s.id === menu!.sessionId) ?? null;
  }
</script>

<svelte:window
  onclick={() => closeMenu()}
  onkeydown={(e) => {
    if (e.key === "Escape") closeMenu();
  }}
/>

<aside class="sessions-rail">
  <div class="pane-header">
    <span>Sessions</span>
    <button
      type="button"
      class="add-btn"
      title={`New session (${chordFor("newSession")})`}
      disabled={creating}
      onclick={() => onCreate?.()}
    >
      {creating ? "…" : "+"}
    </button>
  </div>
  {#if sessions.length === 0}
    <div class="empty muted">No sessions yet</div>
  {:else}
    <ul class="list">
      {#each sessions as s, i (s.id)}
        {@const label = statusLabel(s)}
        {@const isEditing = editingId === s.id}
        <li>
          <!-- svelte-ignore a11y_no_static_element_interactions -->
          <div
            class="session-row"
            class:active={s.id === activeId}
            class:expanded={s.id === expandedId}
            class:busy={s.activity === "busy"}
            class:tui={s.activity === "tui" || s.tuiActive}
            class:starting={s.starting || s.status === "starting"}
            class:editing={isEditing}
            role="group"
            oncontextmenu={(e) => openMenu(e, s.id)}
          >
            {#if isEditing}
              <div class="rename-row">
                <span class="at muted">@</span>
                <input
                  bind:this={inputEl}
                  class="rename-input mono"
                  bind:value={editValue}
                  disabled={renaming}
                  maxlength={48}
                  spellcheck="false"
                  aria-label="Session name"
                  onkeydown={(e) => onEditKeydown(e, s.id)}
                  onblur={() => {
                    if (!renaming) void commitRename(s.id);
                  }}
                />
                {#if renameError}
                  <span class="rename-err" title={renameError}>!</span>
                {/if}
              </div>
            {:else}
              <button
                type="button"
                class="session-main"
                title={statusTitle(s, i)}
                onclick={() => onOpen?.(s.id)}
              >
                <span
                  class="dot"
                  class:running={s.status === "running" && s.activity === "idle" && !s.starting}
                  class:busy-dot={s.activity === "busy"}
                  class:tui-dot={s.activity === "tui" || s.tuiActive}
                  class:starting-dot={s.starting || s.status === "starting"}
                  class:exited={s.status === "exited"}
                ></span>
                <span class="meta">
                  <span class="mono name">@{s.name}</span>
                  {#if (s.activity === "busy" || s.activity === "tui") && s.lastCommand}
                    <span class="last mono">{s.lastCommand}</span>
                  {:else if i < 9}
                    <span class="last muted key-hint">{chordFor(`session${i + 1}` as "session1")}</span>
                  {/if}
                </span>
                <span class="muted sm" class:accent={label === "busy" || label === "tui" || label === "starting"}>
                  {label}
                </span>
              </button>
              <div class="row-actions">
                <button
                  type="button"
                  class="icon-btn"
                  title={`Rename (${chordFor("renameSession")})`}
                  aria-label={`Rename @${s.name}`}
                  onclick={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    beginRename(s.id);
                  }}
                >
                  <!-- pencil -->
                  <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                    <path
                      d="M11.5 1.5l3 3L5 14H2v-3L11.5 1.5z"
                      stroke="currentColor"
                      stroke-width="1.4"
                      stroke-linejoin="round"
                    />
                  </svg>
                </button>
                {#if canRemove}
                  <button
                    type="button"
                    class="icon-btn danger"
                    title={`Close (${chordFor("closeSession")})`}
                    aria-label={`Close @${s.name}`}
                    onclick={(e) => handleClose(e, s.id)}
                  >
                    ×
                  </button>
                {/if}
              </div>
            {/if}
          </div>
        </li>
      {/each}
    </ul>
  {/if}

  <div class="rail-footer muted">
    <span>Right-click · {chordFor("newSession")} new</span>
  </div>
</aside>

{#if menu && menuSession()}
  {@const ms = menuSession()!}
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <div
    class="ctx-menu"
    style:left="{menu.x}px"
    style:top="{menu.y}px"
    role="menu"
    tabindex="-1"
    onclick={(e) => e.stopPropagation()}
  >
    <button
      type="button"
      class="ctx-item"
      role="menuitem"
      onclick={() => {
        onOpen?.(ms.id);
        closeMenu();
      }}
    >
      <span>Open terminal</span>
      <kbd>{chordFor("toggleTerminal")}</kbd>
    </button>
    <button
      type="button"
      class="ctx-item"
      role="menuitem"
      onclick={() => beginRename(ms.id)}
    >
      <span>Rename</span>
      <kbd>{chordFor("renameSession")}</kbd>
    </button>
    {#if canRemove}
      <button
        type="button"
        class="ctx-item danger"
        role="menuitem"
        onclick={() => {
          onClose?.(ms.id);
          closeMenu();
        }}
      >
        <span>Close</span>
        <kbd>{chordFor("closeSession")}</kbd>
      </button>
    {/if}
  </div>
{/if}

<style>
  .sessions-rail {
    box-sizing: border-box;
    /* Width comes from parent grid column (240px); fill the area. */
    width: 100%;
    min-width: 0;
    background: var(--bg-panel, #12151c);
    border-left: 1px solid var(--border, #232833);
    color: var(--text, #e8eaed);
    min-height: 0;
    height: 100%;
    max-height: 100%;
    overflow: hidden;
    display: flex;
    flex-direction: column;
  }

  .pane-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0.75rem 0.85rem;
    border-bottom: 1px solid var(--border, #232833);
    font-size: 0.9rem;
    color: var(--muted, #8b93a7);
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
    cursor: wait;
  }

  .list {
    list-style: none;
    margin: 0;
    padding: 0.35rem 0;
    flex: 1;
    min-height: 0;
    overflow-y: auto;
  }

  .session-row {
    display: flex;
    align-items: stretch;
    width: 100%;
  }

  .session-row:hover {
    background: color-mix(in srgb, var(--accent, #4c8dff) 8%, transparent);
  }

  .session-row.active {
    background: color-mix(in srgb, var(--accent, #4c8dff) 12%, transparent);
  }

  .session-row.expanded {
    box-shadow: inset 2px 0 0 var(--accent, #4c8dff);
  }

  .session-row.busy {
    background: color-mix(in srgb, var(--accent, #4c8dff) 10%, transparent);
  }

  .session-row.tui {
    background: color-mix(in srgb, #c792ea 12%, transparent);
  }

  .session-row.starting {
    opacity: 0.85;
  }

  .session-row.editing {
    background: color-mix(in srgb, var(--accent, #4c8dff) 14%, transparent);
  }

  .session-main {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    flex: 1;
    min-width: 0;
    padding: 0.55rem 0.15rem 0.55rem 0.85rem;
    border: none;
    background: transparent;
    color: inherit;
    font: inherit;
    text-align: left;
    cursor: pointer;
  }

  .row-actions {
    display: flex;
    align-items: center;
    gap: 0.1rem;
    padding-right: 0.35rem;
    opacity: 0;
    transition: opacity 0.12s ease;
  }

  .session-row:hover .row-actions,
  .session-row.active .row-actions,
  .session-row:focus-within .row-actions {
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
    font-size: 1.05rem;
    line-height: 1;
    padding: 0;
  }

  .icon-btn:hover {
    background: color-mix(in srgb, var(--accent, #4c8dff) 16%, transparent);
    color: var(--text, #e8eaed);
  }

  .icon-btn.danger:hover {
    background: color-mix(in srgb, #e35d6a 18%, transparent);
    color: #ffb4bc;
  }

  .rename-row {
    display: flex;
    align-items: center;
    gap: 0.15rem;
    flex: 1;
    min-width: 0;
    padding: 0.45rem 0.55rem 0.45rem 0.85rem;
  }

  .at {
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    font-size: 0.85rem;
    flex-shrink: 0;
  }

  .rename-input {
    flex: 1;
    min-width: 0;
    border: 1px solid var(--accent, #4c8dff);
    border-radius: 6px;
    background: var(--bg-elevated, #161a22);
    color: var(--text, #e8eaed);
    padding: 0.3rem 0.4rem;
    font-size: 0.85rem;
    outline: none;
  }

  .rename-input:disabled {
    opacity: 0.7;
  }

  .rename-err {
    flex-shrink: 0;
    width: 1.2rem;
    height: 1.2rem;
    border-radius: 50%;
    background: color-mix(in srgb, #e35d6a 35%, transparent);
    color: #ffb4bc;
    font-size: 0.75rem;
    font-weight: 700;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    cursor: help;
  }

  .dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--muted, #8b93a7);
    flex-shrink: 0;
  }

  .dot.running {
    background: var(--ok, #3dd68c);
    box-shadow: 0 0 8px color-mix(in srgb, var(--ok, #3dd68c) 55%, transparent);
  }

  .dot.busy-dot {
    background: var(--accent, #4c8dff);
    box-shadow: 0 0 8px color-mix(in srgb, var(--accent, #4c8dff) 55%, transparent);
    animation: pulse 1s ease-in-out infinite;
  }

  .dot.tui-dot {
    background: #c792ea;
    box-shadow: 0 0 8px color-mix(in srgb, #c792ea 55%, transparent);
    animation: pulse 1.2s ease-in-out infinite;
  }

  .dot.starting-dot {
    background: var(--idle, #f0b429);
    box-shadow: 0 0 8px color-mix(in srgb, var(--idle, #f0b429) 55%, transparent);
    animation: pulse 0.7s ease-in-out infinite;
  }

  .dot.exited {
    background: #e35d6a;
  }

  @keyframes pulse {
    0%,
    100% {
      opacity: 1;
    }
    50% {
      opacity: 0.45;
    }
  }

  .meta {
    display: flex;
    flex-direction: column;
    gap: 0.1rem;
    min-width: 0;
    flex: 1;
  }

  .mono {
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    font-size: 0.85rem;
  }

  .name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .last {
    font-size: 0.68rem;
    color: var(--muted, #8b93a7);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .key-hint {
    font-size: 0.65rem;
    opacity: 0.75;
  }

  .muted {
    color: var(--muted, #8b93a7);
  }

  .sm {
    font-size: 0.72rem;
    margin-left: auto;
    text-transform: capitalize;
    flex-shrink: 0;
  }

  .sm.accent {
    color: var(--accent, #4c8dff);
    font-weight: 600;
  }

  .session-row.tui .sm.accent {
    color: #c792ea;
  }

  .empty {
    padding: 1rem;
    font-size: 0.85rem;
  }

  .rail-footer {
    padding: 0.45rem 0.85rem 0.65rem;
    font-size: 0.68rem;
    border-top: 1px solid var(--border, #232833);
  }

  .ctx-menu {
    position: fixed;
    z-index: 1000;
    min-width: 12rem;
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
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 1rem;
    border: none;
    background: transparent;
    color: var(--text, #e8eaed);
    font: inherit;
    font-size: 0.85rem;
    text-align: left;
    padding: 0.45rem 0.55rem;
    border-radius: 7px;
    cursor: pointer;
  }

  .ctx-item:hover {
    background: color-mix(in srgb, var(--accent, #4c8dff) 16%, transparent);
  }

  .ctx-item.danger {
    color: #ffb4bc;
  }

  .ctx-item.danger:hover {
    background: color-mix(in srgb, #e35d6a 18%, transparent);
  }

  .ctx-item kbd {
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    font-size: 0.7rem;
    color: var(--muted, #8b93a7);
    border: 1px solid var(--border, #232833);
    border-radius: 4px;
    padding: 0.05rem 0.3rem;
  }
</style>
