<script lang="ts">
  import { chordFor } from "$lib/stores";
  import type { SessionInfo } from "$lib/types";
  import {
    listShellProfiles,
    loadRecentSshTargets,
    profileIsSsh,
    rememberSshTarget,
    type ShellProfile,
  } from "$lib/session/profiles";
  import { clampPopupPosition, portal } from "$lib/portal";

  interface Props {
    sessions: SessionInfo[];
    activeId: string | null;
    selectedId?: string | null;
    focused?: boolean;
    expandedId?: string | null;
    canRemove?: boolean;
    creating?: boolean;
    /** Session currently in rename mode (controlled from parent for rename hotkey). */
    renameTargetId?: string | null;
    /** Increment to open the profile picker (e.g. new-session hotkey from parent). */
    openCreateRequest?: number;
    /** Focused full terminal (overlay). */
    onOpen?: (sessionId: string) => void;
    /** Select / sticky only. */
    onSelect?: (sessionId: string) => void;
    /** Open as embedded pane on the main work surface. */
    onOpenInPane?: (sessionId: string) => void;
    onHighlight?: (sessionId: string) => void;
    onFocusRegion?: () => void;
    /** Create a session; sshTarget required for SSH profiles. */
    onCreate?: (
      profileId: string,
      sshTarget?: string,
    ) => void | Promise<void>;
    onClose?: (sessionId: string) => void;
    onRename?: (sessionId: string, name: string) => void | Promise<void>;
    onBeginRename?: (sessionId: string) => void;
    onCancelRename?: () => void;
  }

  let {
    sessions,
    activeId,
    selectedId = null,
    focused = false,
    expandedId = null,
    canRemove = true,
    creating = false,
    renameTargetId = null,
    openCreateRequest = 0,
    onOpen,
    onSelect,
    onOpenInPane,
    onHighlight,
    onFocusRegion,
    onCreate,
    onClose,
    onRename,
    onBeginRename,
    onCancelRename,
  }: Props = $props();

  const highlightId = $derived(selectedId ?? activeId);

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

  let createOpen = $state(false);
  /** "type" = pick shell/SSH profile; "ssh" = enter destination. */
  let createStep = $state<"type" | "ssh">("type");
  let profiles = $state<ShellProfile[]>([]);
  let defaultProfileId = $state("");
  let profilesError = $state<string | null>(null);
  let profileHighlight = $state(0);
  let pendingProfileId = $state<string | null>(null);
  let sshTarget = $state("");
  let sshError = $state<string | null>(null);
  let recentSsh = $state<string[]>([]);
  let sshSuggestOpen = $state(false);
  let sshSuggestHighlight = $state(0);
  let createMenuEl: HTMLDivElement | undefined = $state();
  let sshInputEl: HTMLInputElement | undefined = $state();
  let addBtnEl: HTMLButtonElement | undefined = $state();
  let createMenuPos = $state({ top: 0, left: 0 });
  let lastCreateRequest = 0;

  function placeCreateMenu() {
    const btn = addBtnEl;
    if (!btn) return;
    const r = btn.getBoundingClientRect();
    const estW = createStep === "ssh" ? 260 : 220;
    const estH = createStep === "ssh" ? 220 : 280;
    // Align menu's top-right under the + button (opens into the chat).
    const rawLeft = r.right - estW;
    const rawTop = r.bottom + 6;
    createMenuPos = clampPopupPosition(rawLeft, rawTop, estW, estH);
  }

  const filteredSshRecents = $derived.by(() => {
    const q = sshTarget.trim().toLowerCase();
    if (!q) return recentSsh;
    return recentSsh.filter((t) => t.toLowerCase().includes(q));
  });

  /** Bumps when picker closes so in-flight open work cannot re-show a second pane. */
  let createEpoch = 0;

  $effect(() => {
    const n = openCreateRequest;
    if (n > lastCreateRequest) {
      lastCreateRequest = n;
      toggleCreatePicker();
    }
  });

  // Dismiss create picker only after the sessions rail *had* focus and then lost it.
  // Do not close when opening via hotkey while composer/other region was focused
  // (focused is still false on the first open frame).
  let createPickerSawFocus = false;
  $effect(() => {
    if (focused) {
      createPickerSawFocus = true;
      return;
    }
    if (createPickerSawFocus && createOpen) {
      closeCreatePicker();
    }
    if (!createOpen) createPickerSawFocus = false;
  });

  async function loadProfiles() {
    profilesError = null;
    try {
      const payload = await listShellProfiles();
      profiles = payload.profiles;
      defaultProfileId = payload.defaultProfileId;
      const defIdx = profiles.findIndex((p) => p.id === defaultProfileId);
      profileHighlight = defIdx >= 0 ? defIdx : 0;
    } catch (err) {
      profiles = [];
      profilesError = String(err).replace(/^Error:\s*/, "");
    }
  }

  /** Single entry point: open if closed, close if open — never stack panes. */
  function toggleCreatePicker() {
    if (creating) return;
    if (createOpen) {
      closeCreatePicker();
      return;
    }
    void openCreatePicker();
  }

  async function openCreatePicker() {
    if (creating) return;
    // Never stack: if somehow still marked open, close first then re-open.
    if (createOpen) {
      closeCreatePicker();
    }
    closeMenu();
    scrubOrphanCreateMenus();
    const epoch = ++createEpoch;
    createStep = "type";
    pendingProfileId = null;
    sshTarget = "";
    sshError = null;
    sshSuggestOpen = false;
    placeCreateMenu();
    createOpen = true;
    await loadProfiles();
    // Closed (or re-opened) while profiles were loading — abort this open.
    if (epoch !== createEpoch || !createOpen) return;
    requestAnimationFrame(() => {
      if (epoch !== createEpoch || !createOpen) return;
      placeCreateMenu();
      // Refine with real size after paint.
      const el = createMenuEl;
      if (el && addBtnEl) {
        const r = addBtnEl.getBoundingClientRect();
        const w = el.offsetWidth || 220;
        const h = el.offsetHeight || 200;
        createMenuPos = clampPopupPosition(r.right - w, r.bottom + 6, w, h);
      }
      // Prefer menu focus so arrow keys work immediately (leave composer).
      const item = createMenuEl?.querySelector<HTMLButtonElement>(
        ".profile-item.highlight",
      );
      if (item) {
        item.focus();
      } else {
        createMenuEl?.focus();
      }
    });
  }

  function onWindowReposition() {
    if (createOpen) placeCreateMenu();
  }

  /** Drop any portaled create menus left on body after state says closed. */
  function scrubOrphanCreateMenus() {
    document
      .querySelectorAll("[data-chatty-create-menu]")
      .forEach((el) => el.remove());
  }

  function closeCreatePicker() {
    createEpoch += 1;
    createOpen = false;
    createStep = "type";
    pendingProfileId = null;
    sshTarget = "";
    sshError = null;
    profilesError = null;
    sshSuggestOpen = false;
    createMenuEl = undefined;
    // Portal may race Svelte unmount; force-remove leftovers on body.
    queueMicrotask(() => {
      if (!createOpen) scrubOrphanCreateMenus();
    });
  }

  function isInsideCreateUi(target: EventTarget | null): boolean {
    if (!(target instanceof Element)) return false;
    // Use DOM attributes so this still works after portal moves the menu.
    if (target.closest("[data-chatty-create-btn]")) return true;
    if (target.closest("[data-chatty-create-menu]")) return true;
    return false;
  }

  /**
   * Capture-phase dismiss: click outside menu / + button closes the picker.
   * + button is excluded here so its own handler can toggle (open ↔ close).
   */
  function onGlobalPointerDown(e: PointerEvent) {
    const t = e.target;

    if (menu) {
      if (t instanceof Element && t.closest(".ctx-menu")) {
        /* keep open */
      } else {
        closeMenu();
      }
    }

    // + button: leave toggle to the button handler (must not close-then-open).
    if (t instanceof Element && t.closest("[data-chatty-create-btn]")) {
      return;
    }

    if (!createOpen) {
      // State closed but a ghost may still be visible — kill it on any outside click.
      if (
        t instanceof Element &&
        !t.closest("[data-chatty-create-menu]")
      ) {
        scrubOrphanCreateMenus();
      }
      return;
    }

    if (isInsideCreateUi(t)) return;
    closeCreatePicker();
  }

  // Capture on window so terminal / other stopPropagation still dismisses.
  $effect(() => {
    const handler = (e: PointerEvent) => onGlobalPointerDown(e);
    window.addEventListener("pointerdown", handler, true);
    return () => window.removeEventListener("pointerdown", handler, true);
  });

  function openSshStep(profileId: string) {
    pendingProfileId = profileId;
    createStep = "ssh";
    sshTarget = "";
    sshError = null;
    recentSsh = loadRecentSshTargets();
    sshSuggestOpen = recentSsh.length > 0;
    sshSuggestHighlight = 0;
    placeCreateMenu();
    requestAnimationFrame(() => {
      placeCreateMenu();
      const el = createMenuEl;
      if (el && addBtnEl) {
        const r = addBtnEl.getBoundingClientRect();
        const w = el.offsetWidth || 260;
        const h = el.offsetHeight || 220;
        createMenuPos = clampPopupPosition(r.right - w, r.bottom + 6, w, h);
      }
      sshInputEl?.focus();
      sshInputEl?.select();
    });
  }

  async function pickProfile(profileId: string) {
    if (creating) return;
    const p = profiles.find((x) => x.id === profileId);
    if (p && profileIsSsh(p)) {
      openSshStep(profileId);
      return;
    }
    closeCreatePicker();
    await onCreate?.(profileId);
  }

  async function confirmSshTarget(target?: string) {
    if (creating) return;
    const profileId = pendingProfileId;
    if (!profileId) return;
    const t = (target ?? sshTarget).trim();
    if (!t) {
      sshError = "Destination required (e.g. user@host)";
      return;
    }
    if (/\s/.test(t) && !t.startsWith("[")) {
      sshError = "Use host or user@host (no spaces)";
      return;
    }
    rememberSshTarget(t);
    closeCreatePicker();
    await onCreate?.(profileId, t);
  }

  function focusHighlightedProfile() {
    requestAnimationFrame(() => {
      createMenuEl
        ?.querySelector<HTMLButtonElement>(".profile-item.highlight")
        ?.focus();
    });
  }

  /** @returns true if the event was handled for the create menu */
  function handleCreateMenuNav(e: KeyboardEvent): boolean {
    if (!createOpen) return false;
    if (e.altKey || e.metaKey || e.ctrlKey) return false;

    if (createStep === "ssh") {
      // SSH step: let the input handle typing; only Esc here if not in field
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        if (sshSuggestOpen && filteredSshRecents.length > 0) {
          sshSuggestOpen = false;
          return true;
        }
        createStep = "type";
        pendingProfileId = null;
        sshError = null;
        focusHighlightedProfile();
        return true;
      }
      return false;
    }

    if (profiles.length === 0) {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        closeCreatePicker();
        return true;
      }
      return false;
    }

    const key = e.key;
    const down = key === "ArrowDown" || key === "j" || key === "J";
    const up = key === "ArrowUp" || key === "k" || key === "K";

    if (key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      closeCreatePicker();
      return true;
    }
    if (down) {
      e.preventDefault();
      e.stopPropagation();
      profileHighlight = (profileHighlight + 1) % profiles.length;
      focusHighlightedProfile();
      return true;
    }
    if (up) {
      e.preventDefault();
      e.stopPropagation();
      profileHighlight =
        (profileHighlight - 1 + profiles.length) % profiles.length;
      focusHighlightedProfile();
      return true;
    }
    if (key === "Enter") {
      e.preventDefault();
      e.stopPropagation();
      const p = profiles[profileHighlight];
      if (p) void pickProfile(p.id);
      return true;
    }
    if (key === "Home") {
      e.preventDefault();
      e.stopPropagation();
      profileHighlight = 0;
      focusHighlightedProfile();
      return true;
    }
    if (key === "End") {
      e.preventDefault();
      e.stopPropagation();
      profileHighlight = profiles.length - 1;
      focusHighlightedProfile();
      return true;
    }
    return false;
  }

  function onCreateMenuKeydown(e: KeyboardEvent) {
    handleCreateMenuNav(e);
  }

  // Capture while open so ↑↓/hjkl aren't stolen by rail list nav or composer history.
  $effect(() => {
    if (!createOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (handleCreateMenuNav(e)) return;
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  });

  function onSshInputKeydown(e: KeyboardEvent) {
    const list = filteredSshRecents;
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      if (sshSuggestOpen && list.length > 0) {
        sshSuggestOpen = false;
        return;
      }
      createStep = "type";
      pendingProfileId = null;
      sshError = null;
      requestAnimationFrame(() => {
        createMenuEl
          ?.querySelector<HTMLButtonElement>(".profile-item.highlight")
          ?.focus();
      });
      return;
    }
    if (e.key === "ArrowDown" && list.length > 0) {
      e.preventDefault();
      sshSuggestOpen = true;
      sshSuggestHighlight = (sshSuggestHighlight + 1) % list.length;
      return;
    }
    if (e.key === "ArrowUp" && list.length > 0) {
      e.preventDefault();
      sshSuggestOpen = true;
      sshSuggestHighlight =
        (sshSuggestHighlight - 1 + list.length) % list.length;
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      if (
        sshSuggestOpen &&
        list.length > 0 &&
        sshSuggestHighlight >= 0 &&
        sshSuggestHighlight < list.length
      ) {
        const pick = list[sshSuggestHighlight];
        sshTarget = pick;
        void confirmSshTarget(pick);
        return;
      }
      void confirmSshTarget();
      return;
    }
    if (e.key === "Tab" && sshSuggestOpen && list.length > 0) {
      e.preventDefault();
      sshTarget = list[sshSuggestHighlight] ?? sshTarget;
      sshSuggestOpen = false;
    }
  }

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
    closeCreatePicker();
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
  onkeydown={(e) => {
    if (e.key === "Escape") {
      closeMenu();
      closeCreatePicker();
    }
  }}
  onresize={onWindowReposition}
  onscroll={onWindowReposition}
/>

<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
<aside
  class="sessions-rail"
  class:region-focused={focused}
  data-focus-region="sessions"
  tabindex="0"
  onfocus={() => onFocusRegion?.()}
>
  <div class="pane-header">
    <span>Sessions</span>
    <div class="add-wrap">
      <button
        bind:this={addBtnEl}
        type="button"
        class="add-btn"
        data-chatty-create-btn
        tabindex="-1"
        title={`New session (${chordFor("newSession")})`}
        disabled={creating}
        aria-haspopup="listbox"
        aria-expanded={createOpen}
        onpointerdown={(e) => {
          // Capture-phase global handler skips this button; we own toggle here.
          e.preventDefault();
          e.stopPropagation();
          toggleCreatePicker();
        }}
        onclick={(e) => {
          // pointerdown already handled; block a following click from re-firing.
          e.preventDefault();
          e.stopPropagation();
        }}
      >
        {creating ? "…" : "+"}
      </button>
    </div>
  </div>
  {#if sessions.length === 0}
    <div class="empty muted">No sessions yet</div>
  {:else}
    <ul class="list" role="listbox" aria-label="Sessions">
      {#each sessions as s, i (s.id)}
        {@const label = statusLabel(s)}
        {@const isEditing = editingId === s.id}
        {@const isSelected = highlightId === s.id}
        <li>
          <!-- svelte-ignore a11y_no_static_element_interactions a11y_interactive_supports_focus -->
          <div
            class="session-row"
            class:active={s.id === activeId}
            class:selected={isSelected}
            class:expanded={s.id === expandedId}
            class:busy={s.activity === "busy"}
            class:tui={s.activity === "tui" || s.tuiActive}
            class:starting={s.starting || s.status === "starting"}
            class:editing={isEditing}
            role="option"
            aria-selected={isSelected}
            tabindex="-1"
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
                tabindex="-1"
                onclick={() => {
                  onHighlight?.(s.id);
                  // Click opens focused terminal (select + sticky included in onOpen).
                  onOpen?.(s.id);
                }}
                ondblclick={(e) => {
                  // Double-click prefers workspace pane over toggling overlay closed.
                  e.preventDefault();
                  onHighlight?.(s.id);
                  onOpenInPane?.(s.id);
                }}
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
                  <span class="subrow">
                    <span class="sub-left mono">
                      {#if (s.activity === "busy" || s.activity === "tui") && s.lastCommand}
                        <span class="last">{s.lastCommand}</span>
                      {:else if i < 9}
                        <span class="last muted key-hint"
                          >{chordFor(`session${i + 1}` as "session1")}</span
                        >
                      {:else}
                        <span class="last muted">&nbsp;</span>
                      {/if}
                    </span>
                    <span
                      class="status-word muted"
                      class:accent={label === "busy" ||
                        label === "tui" ||
                        label === "starting"}
                    >
                      {label}
                    </span>
                  </span>
                </span>
              </button>
              <div class="row-actions">
                <button
                  type="button"
                  class="icon-btn"
                  tabindex="-1"
                  title={`Open in new pane (${chordFor("openInPane")}${i < 9 ? ` · ${chordFor(`openSessionInNewPane${i + 1}` as "openSessionInNewPane1")}` : ""})`}
                  aria-label={`Open @${s.name} in a new workspace pane`}
                  onclick={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    onOpenInPane?.(s.id);
                  }}
                >
                  <!-- panels -->
                  <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                    <rect
                      x="1.5"
                      y="2.5"
                      width="13"
                      height="11"
                      rx="1.5"
                      stroke="currentColor"
                      stroke-width="1.4"
                    />
                    <path d="M7 2.5v11" stroke="currentColor" stroke-width="1.4" />
                  </svg>
                </button>
                <button
                  type="button"
                  class="icon-btn"
                  tabindex="-1"
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
                    tabindex="-1"
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

{#if createOpen}
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div
    class="create-menu"
    class:ssh-step={createStep === "ssh"}
    data-chatty-create-menu
    use:portal
    bind:this={createMenuEl}
    role={createStep === "type" ? "listbox" : "dialog"}
    aria-label={createStep === "type" ? "Session type" : "SSH destination"}
    tabindex="-1"
    style:top="{createMenuPos.top}px"
    style:left="{createMenuPos.left}px"
    onkeydown={onCreateMenuKeydown}
  >
    {#if createStep === "ssh"}
      <div class="create-menu-title">SSH destination</div>
      <p class="ssh-help muted">user@host or host — same as the ssh CLI</p>
      <div class="ssh-field">
        <input
          bind:this={sshInputEl}
          class="ssh-input mono"
          type="text"
          placeholder="user@example.com"
          bind:value={sshTarget}
          spellcheck="false"
          autocomplete="off"
          autocapitalize="off"
          aria-label="SSH destination"
          aria-autocomplete="list"
          oninput={() => {
            sshError = null;
            sshSuggestOpen = true;
            sshSuggestHighlight = 0;
          }}
          onfocus={() => {
            if (recentSsh.length > 0) sshSuggestOpen = true;
          }}
          onkeydown={onSshInputKeydown}
        />
        {#if sshSuggestOpen && filteredSshRecents.length > 0}
          <ul class="ssh-suggest" role="listbox" aria-label="Recent destinations">
            {#each filteredSshRecents as t, i (t)}
              <li>
                <button
                  type="button"
                  class="ssh-suggest-item mono"
                  class:highlight={i === sshSuggestHighlight}
                  role="option"
                  aria-selected={i === sshSuggestHighlight}
                  onmouseenter={() => (sshSuggestHighlight = i)}
                  onclick={() => void confirmSshTarget(t)}
                >
                  {t}
                </button>
              </li>
            {/each}
          </ul>
        {/if}
      </div>
      {#if sshError}
        <div class="create-menu-error">{sshError}</div>
      {/if}
      <div class="ssh-actions">
        <button
          type="button"
          class="ssh-btn ghost"
          onclick={() => {
            createStep = "type";
            pendingProfileId = null;
            sshError = null;
            placeCreateMenu();
            requestAnimationFrame(() => placeCreateMenu());
          }}
        >
          Back
        </button>
        <button
          type="button"
          class="ssh-btn primary"
          disabled={!sshTarget.trim()}
          onclick={() => void confirmSshTarget()}
        >
          Connect
        </button>
      </div>
      <div class="create-menu-hint muted">
        ↑↓ recent · Enter connect · Esc back
      </div>
    {:else}
      <div class="create-menu-title">Session type</div>
      {#if profilesError}
        <div class="create-menu-error">{profilesError}</div>
      {:else if profiles.length === 0}
        <div class="create-menu-empty muted">No profiles found</div>
      {:else}
        {#each profiles as p, i (p.id)}
          <button
            type="button"
            class="profile-item"
            class:highlight={i === profileHighlight}
            class:is-default={p.id === defaultProfileId}
            role="option"
            aria-selected={i === profileHighlight}
            onmouseenter={() => (profileHighlight = i)}
            onclick={() => void pickProfile(p.id)}
          >
            <span class="profile-label">{p.label}</span>
            <span class="profile-meta mono" title={p.shell}>
              {p.id === defaultProfileId ? "default · " : ""}{profileIsSsh(p)
                ? "ssh · enter host next"
                : p.shell.split("/").pop()}
            </span>
          </button>
        {/each}
      {/if}
      <div class="create-menu-hint muted">
        Edit ~/.config/chatty/profiles.json
      </div>
    {/if}
  </div>
{/if}

{#if menu && menuSession()}
  {@const ms = menuSession()!}
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <div
    class="ctx-menu"
    use:portal
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
        onOpenInPane?.(ms.id);
        closeMenu();
      }}
    >
      <span>Open in new pane</span>
      <kbd>{chordFor("openInPane")}</kbd>
    </button>
    <button
      type="button"
      class="ctx-item"
      role="menuitem"
      onclick={() => {
        onOpen?.(ms.id);
        closeMenu();
      }}
    >
      <span>Focused terminal</span>
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
    outline: none;
  }

  .sessions-rail.region-focused {
    box-shadow: inset -2px 0 0 0 var(--accent, #4c8dff);
  }

  .session-row.selected:not(.active) {
    outline: 1px solid color-mix(in srgb, var(--accent, #4c8dff) 45%, transparent);
    outline-offset: -1px;
  }

  .pane-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0.75rem 0.85rem;
    border-bottom: 1px solid var(--border, #232833);
    font-size: 0.9rem;
    color: var(--muted, #8b93a7);
    position: relative;
    z-index: 2;
  }

  .add-wrap {
    position: relative;
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

  .create-menu {
    position: fixed;
    min-width: 12.5rem;
    max-width: min(18rem, 80vw);
    max-height: min(70vh, 28rem);
    overflow-y: auto;
    z-index: var(--z-popup, 1000);
    border: 1px solid var(--border, #232833);
    border-radius: 10px;
    background: var(--bg-panel, #12151c);
    box-shadow: 0 8px 28px rgba(0, 0, 0, 0.45);
    padding: 0.35rem;
    display: flex;
    flex-direction: column;
    gap: 0.15rem;
  }

  .create-menu.ssh-step {
    min-width: 15rem;
    max-height: min(70vh, 28rem);
    overflow: visible;
  }

  .create-menu-title {
    font-size: 0.7rem;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--muted, #8b93a7);
    padding: 0.35rem 0.5rem 0.25rem;
  }

  .create-menu-error {
    color: var(--danger, #e35d6a);
    font-size: 0.8rem;
    padding: 0.4rem 0.5rem;
  }

  .create-menu-empty {
    font-size: 0.8rem;
    padding: 0.5rem;
  }

  .create-menu-hint {
    font-size: 0.65rem;
    padding: 0.35rem 0.5rem 0.25rem;
    border-top: 1px solid var(--border, #232833);
    margin-top: 0.2rem;
  }

  .ssh-help {
    font-size: 0.72rem;
    margin: 0;
    padding: 0 0.5rem 0.35rem;
    line-height: 1.35;
  }

  .ssh-field {
    position: relative;
    padding: 0 0.35rem 0.25rem;
  }

  .ssh-input {
    box-sizing: border-box;
    width: 100%;
    border: 1px solid var(--border, #232833);
    border-radius: 7px;
    background: var(--bg-elevated, #161a22);
    color: var(--text, #e8eaed);
    padding: 0.45rem 0.55rem;
    font-size: 0.85rem;
    outline: none;
  }

  .ssh-input:focus {
    border-color: var(--accent, #4c8dff);
    box-shadow: 0 0 0 2px color-mix(in srgb, var(--accent, #4c8dff) 25%, transparent);
  }

  .ssh-suggest {
    list-style: none;
    margin: 0.25rem 0 0;
    padding: 0.2rem;
    border: 1px solid var(--border, #232833);
    border-radius: 8px;
    background: var(--bg-elevated, #161a22);
    max-height: 9rem;
    overflow-y: auto;
  }

  .ssh-suggest-item {
    display: block;
    width: 100%;
    text-align: left;
    border: none;
    border-radius: 6px;
    background: transparent;
    color: var(--text, #e8eaed);
    padding: 0.35rem 0.45rem;
    font: inherit;
    font-size: 0.8rem;
    cursor: pointer;
  }

  .ssh-suggest-item:hover,
  .ssh-suggest-item.highlight {
    background: color-mix(in srgb, var(--accent, #4c8dff) 16%, transparent);
  }

  .ssh-actions {
    display: flex;
    justify-content: flex-end;
    gap: 0.35rem;
    padding: 0.25rem 0.35rem 0.15rem;
  }

  .ssh-btn {
    border-radius: 6px;
    border: 1px solid var(--border, #232833);
    background: var(--bg-elevated, #161a22);
    color: var(--text, #e8eaed);
    font: inherit;
    font-size: 0.8rem;
    padding: 0.3rem 0.65rem;
    cursor: pointer;
  }

  .ssh-btn:hover:not(:disabled) {
    border-color: var(--accent, #4c8dff);
  }

  .ssh-btn.primary {
    background: color-mix(in srgb, var(--accent, #4c8dff) 28%, transparent);
    border-color: color-mix(in srgb, var(--accent, #4c8dff) 55%, var(--border, #232833));
    color: var(--text, #e8eaed);
    font-weight: 600;
  }

  .ssh-btn.primary:disabled {
    opacity: 0.45;
    cursor: not-allowed;
  }

  .ssh-btn.ghost {
    background: transparent;
  }

  .profile-item {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 0.1rem;
    width: 100%;
    text-align: left;
    border: none;
    border-radius: 7px;
    background: transparent;
    color: var(--text, #e8eaed);
    padding: 0.4rem 0.5rem;
    font: inherit;
    cursor: pointer;
  }

  .profile-item:hover,
  .profile-item.highlight {
    background: color-mix(in srgb, var(--accent, #4c8dff) 16%, transparent);
  }

  .profile-label {
    font-size: 0.85rem;
    font-weight: 600;
  }

  .profile-meta {
    font-size: 0.7rem;
    color: var(--muted, #8b93a7);
    max-width: 100%;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .profile-item.is-default .profile-label::after {
    content: "";
  }

  .mono {
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  }

  .muted {
    color: var(--muted, #8b93a7);
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
    position: relative;
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
    width: 100%;
    padding: 0.5rem 0.55rem 0.5rem 0.85rem;
    border: none;
    background: transparent;
    color: inherit;
    font: inherit;
    text-align: left;
    cursor: pointer;
  }

  /* Overlay: zero idle width so @name keeps the full row */
  .row-actions {
    position: absolute;
    top: 50%;
    right: 0.25rem;
    transform: translateY(-50%);
    display: flex;
    align-items: center;
    gap: 0.05rem;
    padding: 0.1rem;
    border-radius: 7px;
    background: color-mix(in srgb, var(--bg-panel, #12151c) 88%, transparent);
    opacity: 0;
    pointer-events: none;
    transition: opacity 0.12s ease;
    z-index: 2;
  }

  /* Mouse hover only — not selected/active/keyboard focus */
  .session-row:hover .row-actions {
    opacity: 1;
    pointer-events: auto;
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
    gap: 0.12rem;
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
    font-weight: 600;
  }

  .subrow {
    display: flex;
    align-items: center;
    gap: 0.35rem;
    min-width: 0;
    width: 100%;
  }

  .sub-left {
    flex: 1;
    min-width: 0;
    overflow: hidden;
  }

  .last {
    display: block;
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

  .status-word {
    flex-shrink: 0;
    font-size: 0.65rem;
    text-transform: capitalize;
    text-align: right;
    max-width: 40%;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .status-word.accent {
    color: var(--accent, #4c8dff);
    font-weight: 600;
  }

  .session-row.tui .status-word.accent {
    color: #c792ea;
  }

  .muted {
    color: var(--muted, #8b93a7);
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
    z-index: var(--z-popup, 1000);
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
