<script lang="ts">
  import { chordFor } from "$lib/stores";
  import type { Conversation, Group, SessionInfo } from "$lib/types";
  import { portal } from "$lib/portal";
  import type { JumpItem } from "$lib/components/JumpPalette.svelte";
  import {
    chromeLayout,
    toggleLeftRails,
    toggleSessionsRail,
  } from "$lib/chromeLayout";
  import {
    appZoom,
    APP_ZOOM_STEP,
    applyAppZoomCss,
    nudgeAppZoom,
    resetAppZoom,
  } from "$lib/zoom";

  interface Props {
    booting?: boolean;
    connected?: boolean;
    /** Focus the palette field when this becomes true (Ctrl+P). */
    paletteOpen?: boolean;
    groups?: Group[];
    conversations?: Conversation[];
    sessions?: SessionInfo[];
    onPaletteOpenChange?: (open: boolean) => void;
    onPick?: (item: JumpItem) => void;
  }

  let {
    booting = false,
    connected = false,
    paletteOpen = false,
    groups = [],
    conversations = [],
    sessions = [],
    onPaletteOpenChange,
    onPick,
  }: Props = $props();

  let menuOpen = $state(false);
  let menuBtnEl: HTMLButtonElement | undefined = $state();
  let menuPos = $state({ top: 0, right: 0 });

  let query = $state("");
  let selectedIdx = $state(0);
  let inputEl: HTMLInputElement | undefined = $state();
  let fieldWrapEl: HTMLDivElement | undefined = $state();
  let resultsOpen = $state(false);
  let dropPos = $state({ top: 0, left: 0, width: 0 });

  const zoom = $derived($appZoom);

  $effect(() => {
    applyAppZoomCss($appZoom);
  });

  const health = $derived(
    booting ? "starting" : connected ? "ok" : "offline",
  );

  const healthTitle = $derived(
    health === "starting"
      ? "Starting session host…"
      : health === "ok"
        ? "Session host ready"
        : "Backend offline — check errors",
  );

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
    void items;
    if (selectedIdx >= items.length) {
      selectedIdx = Math.max(0, items.length - 1);
    }
  });

  // Ctrl+P / jumpPaletteOpen → focus centered field (only on rising edge)
  let prevPaletteOpen = false;
  $effect(() => {
    const open = paletteOpen;
    if (open && !prevPaletteOpen) {
      resultsOpen = true;
      query = "";
      selectedIdx = 0;
      placeDropdown();
      requestAnimationFrame(() => {
        inputEl?.focus();
        inputEl?.select();
        placeDropdown();
      });
    }
    if (!open && prevPaletteOpen && resultsOpen) {
      // External close (e.g. pick handler) — collapse UI if still open.
      resultsOpen = false;
      query = "";
      selectedIdx = 0;
    }
    prevPaletteOpen = open;
  });

  function placeDropdown() {
    const el = fieldWrapEl;
    if (!el) return;
    const r = el.getBoundingClientRect();
    dropPos = {
      top: r.bottom + 4,
      left: r.left,
      width: r.width,
    };
  }

  function openPalette() {
    resultsOpen = true;
    placeDropdown();
    onPaletteOpenChange?.(true);
  }

  function closePalette(opts?: { blur?: boolean }) {
    resultsOpen = false;
    query = "";
    selectedIdx = 0;
    onPaletteOpenChange?.(false);
    if (opts?.blur) inputEl?.blur();
  }

  function pick(item: JumpItem) {
    onPick?.(item);
    closePalette({ blur: true });
  }

  function onFieldFocus() {
    openPalette();
    placeDropdown();
  }

  function onFieldBlur() {
    // Delay so a mousedown on a result can fire first.
    window.setTimeout(() => {
      if (document.activeElement === inputEl) return;
      if (fieldWrapEl?.contains(document.activeElement)) return;
      closePalette();
    }, 120);
  }

  function onFieldKeydown(e: KeyboardEvent) {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      closePalette({ blur: true });
      return;
    }
    if (!resultsOpen) openPalette();
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
      if (it) pick(it);
    }
  }

  function openMenu(e: MouseEvent) {
    e.stopPropagation();
    if (menuOpen) {
      menuOpen = false;
      return;
    }
    const r = menuBtnEl?.getBoundingClientRect();
    if (r) {
      menuPos = {
        top: r.bottom + 6,
        right: Math.max(8, window.innerWidth - r.right),
      };
    }
    menuOpen = true;
  }

  function closeMenu() {
    menuOpen = false;
  }

  function zoomIn() {
    nudgeAppZoom(APP_ZOOM_STEP);
  }
  function zoomOut() {
    nudgeAppZoom(-APP_ZOOM_STEP);
  }
  function zoomReset() {
    resetAppZoom();
  }
</script>

<svelte:window
  onclick={() => closeMenu()}
  onkeydown={(e) => {
    if (e.key === "Escape") closeMenu();
  }}
  onresize={() => {
    if (resultsOpen) placeDropdown();
  }}
/>

<header class="topbar">
  <div class="topbar-side topbar-left">
    <div
      class="brand"
      class:health-ok={health === "ok"}
      class:health-starting={health === "starting"}
      class:health-offline={health === "offline"}
      title={healthTitle}
      role="img"
      aria-label={healthTitle}
    >
      <span class="logo-mark" aria-hidden="true">▶</span>
      <span class="title">Chatty</span>
    </div>
  </div>

  <div class="topbar-center">
    <div class="palette-wrap" bind:this={fieldWrapEl}>
      <input
        bind:this={inputEl}
        class="palette-input"
        data-jump-palette-input
        type="text"
        placeholder="Jump to group, conversation, or @session…"
        title={`Command palette (${chordFor("jumpPalette")})`}
        bind:value={query}
        onfocus={onFieldFocus}
        onblur={onFieldBlur}
        oninput={() => {
          selectedIdx = 0;
          if (!resultsOpen) openPalette();
          placeDropdown();
        }}
        onkeydown={onFieldKeydown}
        autocomplete="off"
        spellcheck="false"
      />
      <kbd class="palette-chord">{chordFor("jumpPalette")}</kbd>
    </div>
  </div>

  <div class="topbar-side topbar-right">
    <button
      bind:this={menuBtnEl}
      type="button"
      class="menu-btn"
      aria-haspopup="menu"
      aria-expanded={menuOpen}
      title="App menu"
      onclick={openMenu}
    >
      <span class="burger" aria-hidden="true">
        <span></span><span></span><span></span>
      </span>
    </button>
  </div>
</header>

{#if resultsOpen}
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <!-- svelte-ignore a11y_interactive_supports_focus -->
  <div
    class="palette-drop"
    use:portal
    role="listbox"
    aria-label="Jump results"
    tabindex="-1"
    style:top="{dropPos.top}px"
    style:left="{dropPos.left}px"
    style:width="{dropPos.width}px"
    onmousedown={(e) => e.preventDefault()}
  >
    <ul class="results">
      {#each items as it, i (it.kind + it.id)}
        <li>
          <button
            type="button"
            class="row"
            class:active={i === selectedIdx}
            role="option"
            aria-selected={i === selectedIdx}
            onclick={() => pick(it)}
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
{/if}

{#if menuOpen}
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div
    class="app-menu"
    use:portal
    role="menu"
    tabindex="-1"
    style:top="{menuPos.top}px"
    style:right="{menuPos.right}px"
    onclick={(e) => e.stopPropagation()}
  >
    <div class="menu-section-label">Layout</div>
    <button
      type="button"
      class="menu-item"
      role="menuitem"
      onclick={() => {
        toggleLeftRails();
        closeMenu();
      }}
    >
      {$chromeLayout.leftRailsVisible ? "Hide" : "Show"} left rails
      <kbd class="menu-kbd">{chordFor("toggleLeftRails")}</kbd>
    </button>
    <button
      type="button"
      class="menu-item"
      role="menuitem"
      onclick={() => {
        toggleSessionsRail();
        closeMenu();
      }}
    >
      {$chromeLayout.sessionsRailVisible ? "Hide" : "Show"} sessions rail
      <kbd class="menu-kbd">{chordFor("toggleSessionsRail")}</kbd>
    </button>
    <div class="menu-section-label">
      App zoom · {Math.round(zoom * 100)}%
    </div>
    <button type="button" class="menu-item" role="menuitem" onclick={zoomIn}>
      Zoom in
      <kbd class="menu-kbd">Ctrl+Shift+=</kbd>
    </button>
    <button type="button" class="menu-item" role="menuitem" onclick={zoomOut}>
      Zoom out
      <kbd class="menu-kbd">Ctrl+Shift+-</kbd>
    </button>
    <button type="button" class="menu-item" role="menuitem" onclick={zoomReset}>
      Reset zoom
      <kbd class="menu-kbd">Ctrl+Shift+0</kbd>
    </button>
  </div>
{/if}

<style>
  .topbar {
    grid-area: top;
    display: grid;
    grid-template-columns: minmax(5rem, 1fr) minmax(12rem, 28rem) minmax(5rem, 1fr);
    align-items: center;
    gap: 0.75rem;
    min-height: 2.5rem;
    padding: 0.35rem 0.65rem;
    border-bottom: 1px solid var(--border, #232833);
    background: var(--bg-panel, #12151c);
  }

  .topbar-side {
    display: flex;
    align-items: center;
    min-width: 0;
  }

  .topbar-left {
    justify-content: flex-start;
  }

  .topbar-right {
    justify-content: flex-end;
  }

  .topbar-center {
    display: flex;
    justify-content: center;
    min-width: 0;
  }

  .brand {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    font-weight: 600;
    flex-shrink: 0;
    user-select: none;
  }

  .logo-mark {
    font-size: 0.8rem;
    line-height: 1;
    transition:
      color 0.15s ease,
      text-shadow 0.15s ease;
  }

  .title {
    font-size: 0.9rem;
    color: var(--text, #e8eaed);
    letter-spacing: 0.01em;
  }

  .brand.health-ok .logo-mark {
    color: var(--ok, #3dd68c);
    text-shadow: 0 0 10px color-mix(in srgb, var(--ok, #3dd68c) 45%, transparent);
  }

  .brand.health-starting .logo-mark {
    color: var(--idle, #f0b429);
    text-shadow: 0 0 10px color-mix(in srgb, var(--idle, #f0b429) 45%, transparent);
    animation: pulse-logo 0.9s ease-in-out infinite;
  }

  .brand.health-offline .logo-mark {
    color: var(--danger, #e35d6a);
    text-shadow: 0 0 10px color-mix(in srgb, var(--danger, #e35d6a) 45%, transparent);
  }

  @keyframes pulse-logo {
    0%,
    100% {
      opacity: 1;
    }
    50% {
      opacity: 0.45;
    }
  }

  .palette-wrap {
    position: relative;
    width: 100%;
    max-width: 28rem;
  }

  .palette-input {
    box-sizing: border-box;
    width: 100%;
    border: 1px solid var(--border, #232833);
    border-radius: 8px;
    background: var(--bg-elevated, #161a22);
    color: var(--text, #e8eaed);
    font: inherit;
    font-size: 0.85rem;
    padding: 0.4rem 3.25rem 0.4rem 0.75rem;
    outline: none;
  }

  .palette-input::placeholder {
    color: var(--muted, #8b93a7);
    opacity: 0.85;
  }

  .palette-input:focus {
    border-color: color-mix(in srgb, var(--accent, #4c8dff) 65%, var(--border, #232833));
    box-shadow: 0 0 0 2px color-mix(in srgb, var(--accent, #4c8dff) 22%, transparent);
  }

  .palette-chord {
    position: absolute;
    right: 0.45rem;
    top: 50%;
    transform: translateY(-50%);
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    font-size: 0.65rem;
    color: var(--muted, #8b93a7);
    border: 1px solid var(--border, #232833);
    border-radius: 4px;
    padding: 0.05rem 0.3rem;
    pointer-events: none;
  }

  .palette-drop {
    position: fixed;
    z-index: var(--z-popup, 1000);
    max-height: min(20rem, 50vh);
    display: flex;
    flex-direction: column;
    border: 1px solid var(--border, #232833);
    border-radius: 10px;
    background: var(--bg-elevated, #161a22);
    box-shadow: 0 12px 36px rgba(0, 0, 0, 0.5);
    overflow: hidden;
  }

  .results {
    list-style: none;
    margin: 0;
    padding: 0.3rem;
    overflow-y: auto;
    flex: 1;
    min-height: 0;
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
    padding: 0.45rem 0.55rem;
    cursor: pointer;
  }

  .row:hover,
  .row.active {
    background: color-mix(in srgb, var(--accent, #4c8dff) 16%, transparent);
  }

  .kind {
    flex-shrink: 0;
    font-size: 0.65rem;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--muted, #8b93a7);
    width: 5.2rem;
  }

  .path {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: 0.85rem;
  }

  .empty {
    padding: 0.65rem 0.55rem;
    font-size: 0.85rem;
  }

  .hint {
    margin: 0;
    padding: 0.35rem 0.65rem 0.45rem;
    font-size: 0.68rem;
    border-top: 1px solid var(--border, #232833);
  }

  .muted {
    color: var(--muted, #8b93a7);
  }

  .menu-btn {
    width: 2rem;
    height: 2rem;
    border: 1px solid var(--border, #232833);
    border-radius: 7px;
    background: var(--bg-elevated, #161a22);
    color: var(--text, #e8eaed);
    cursor: pointer;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    padding: 0;
  }

  .menu-btn:hover,
  .menu-btn[aria-expanded="true"] {
    border-color: var(--accent, #4c8dff);
  }

  .burger {
    display: flex;
    flex-direction: column;
    gap: 3px;
    width: 14px;
  }

  .burger span {
    display: block;
    height: 1.5px;
    width: 100%;
    background: currentColor;
    border-radius: 1px;
  }

  .app-menu {
    position: fixed;
    z-index: var(--z-popup, 1000);
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

  .menu-section-label {
    font-size: 0.65rem;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--muted, #8b93a7);
    padding: 0.35rem 0.5rem 0.2rem;
  }

  .menu-item {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.75rem;
    width: 100%;
    text-align: left;
    border: none;
    border-radius: 7px;
    background: transparent;
    color: var(--text, #e8eaed);
    font: inherit;
    font-size: 0.85rem;
    padding: 0.45rem 0.55rem;
    cursor: pointer;
  }

  .menu-item:hover {
    background: color-mix(in srgb, var(--accent, #4c8dff) 16%, transparent);
  }

  .menu-kbd {
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    font-size: 0.65rem;
    color: var(--muted, #8b93a7);
    border: 1px solid var(--border, #232833);
    border-radius: 4px;
    padding: 0.05rem 0.28rem;
    flex-shrink: 0;
  }
</style>
