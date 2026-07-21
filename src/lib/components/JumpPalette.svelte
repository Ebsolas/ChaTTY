<script lang="ts">
  import type { Conversation, Group, SessionInfo } from "$lib/types";

  export type JumpItem = {
    kind: "group" | "conversation" | "session";
    id: string;
    label: string;
    path: string;
    groupId?: string;
    conversationId?: string;
  };

  interface Props {
    open: boolean;
    groups: Group[];
    conversations: Conversation[];
    sessions: SessionInfo[];
    onClose?: () => void;
    onPick?: (item: JumpItem) => void;
  }

  let { open, groups, conversations, sessions, onClose, onPick }: Props = $props();

  let query = $state("");
  let selectedIdx = $state(0);
  let inputEl: HTMLInputElement | undefined = $state();

  const items = $derived.by(() => {
    const q = query.trim().toLowerCase();
    const out: JumpItem[] = [];
    for (const g of groups) {
      out.push({
        kind: "group",
        id: g.id,
        label: g.name,
        path: g.name,
        groupId: g.id,
      });
    }
    for (const c of conversations) {
      const g = groups.find((x) => x.id === c.groupId);
      out.push({
        kind: "conversation",
        id: c.id,
        label: c.name,
        path: `${g?.name ?? "?"} / ${c.name}`,
        groupId: c.groupId,
        conversationId: c.id,
      });
    }
    for (const s of sessions) {
      const c = conversations.find((x) => x.id === s.conversationId);
      const g = c ? groups.find((x) => x.id === c.groupId) : undefined;
      out.push({
        kind: "session",
        id: s.id,
        label: `@${s.name}`,
        path: `${g?.name ?? "?"} / ${c?.name ?? "?"} / @${s.name}`,
        groupId: c?.groupId,
        conversationId: s.conversationId,
      });
    }
    if (!q) return out.slice(0, 40);
    return out
      .filter(
        (it) =>
          it.label.toLowerCase().includes(q) ||
          it.path.toLowerCase().includes(q),
      )
      .slice(0, 40);
  });

  $effect(() => {
    if (open) {
      query = "";
      selectedIdx = 0;
      requestAnimationFrame(() => inputEl?.focus());
    }
  });

  $effect(() => {
    void items;
    if (selectedIdx >= items.length) selectedIdx = Math.max(0, items.length - 1);
  });

  function onKeydown(e: KeyboardEvent) {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      onClose?.();
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      selectedIdx = Math.min(items.length - 1, selectedIdx + 1);
      return;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      selectedIdx = Math.max(0, selectedIdx - 1);
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      const it = items[selectedIdx];
      if (it) onPick?.(it);
    }
  }
</script>

{#if open}
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div
    class="backdrop"
    role="presentation"
    onclick={() => onClose?.()}
    onkeydown={(e) => {
      if (e.key === "Escape") onClose?.();
    }}
  >
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <!-- svelte-ignore a11y_interactive_supports_focus -->
    <div
      class="panel"
      role="dialog"
      aria-label="Jump to"
      tabindex="-1"
      onclick={(e) => e.stopPropagation()}
      onkeydown={onKeydown}
    >
      <input
        bind:this={inputEl}
        class="query"
        data-jump-palette-input
        type="text"
        placeholder="Jump to group, conversation, or @session…"
        bind:value={query}
        oninput={() => {
          selectedIdx = 0;
        }}
        autocomplete="off"
        spellcheck="false"
      />
      <ul class="results" role="listbox">
        {#each items as it, i (it.kind + it.id)}
          <li>
            <button
              type="button"
              class="row"
              class:active={i === selectedIdx}
              role="option"
              aria-selected={i === selectedIdx}
              onclick={() => onPick?.(it)}
              onmouseenter={() => {
                selectedIdx = i;
              }}
            >
              <span class="kind">{it.kind}</span>
              <span class="path">{it.path}</span>
            </button>
          </li>
        {/each}
        {#if items.length === 0}
          <li class="empty muted">No matches</li>
        {/if}
      </ul>
      <p class="hint muted">↑↓ select · Enter open · Esc close</p>
    </div>
  </div>
{/if}

<style>
  .backdrop {
    position: fixed;
    inset: 0;
    z-index: 100;
    background: rgba(0, 0, 0, 0.45);
    display: flex;
    align-items: flex-start;
    justify-content: center;
    padding-top: min(20vh, 8rem);
  }

  .panel {
    width: min(32rem, calc(100vw - 2rem));
    background: var(--bg-elevated, #161a22);
    border: 1px solid var(--border, #232833);
    border-radius: 12px;
    box-shadow: 0 16px 48px rgba(0, 0, 0, 0.5);
    overflow: hidden;
  }

  .query {
    width: 100%;
    box-sizing: border-box;
    border: none;
    border-bottom: 1px solid var(--border, #232833);
    background: transparent;
    color: var(--text, #e8eaed);
    font: inherit;
    font-size: 1rem;
    padding: 0.85rem 1rem;
    outline: none;
  }

  .results {
    list-style: none;
    margin: 0;
    padding: 0.35rem;
    max-height: 18rem;
    overflow-y: auto;
  }

  .row {
    width: 100%;
    display: flex;
    align-items: center;
    gap: 0.65rem;
    text-align: left;
    border: none;
    border-radius: 8px;
    background: transparent;
    color: var(--text, #e8eaed);
    font: inherit;
    padding: 0.5rem 0.65rem;
    cursor: pointer;
  }

  .row:hover,
  .row.active {
    background: color-mix(in srgb, var(--accent, #4c8dff) 16%, transparent);
  }

  .kind {
    flex-shrink: 0;
    font-size: 0.68rem;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--muted, #8b93a7);
    width: 5.5rem;
  }

  .path {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .empty {
    padding: 0.75rem 0.65rem;
    font-size: 0.85rem;
  }

  .hint {
    margin: 0;
    padding: 0.4rem 0.85rem 0.55rem;
    font-size: 0.72rem;
    border-top: 1px solid var(--border, #232833);
  }

  .muted {
    color: var(--muted, #8b93a7);
  }
</style>
