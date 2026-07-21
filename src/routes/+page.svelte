<script lang="ts">
  import { onMount } from "svelte";
  import { get } from "svelte/store";
  import { invoke } from "@tauri-apps/api/core";
  import { getCurrentWindow } from "@tauri-apps/api/window";
  import BusyIndicator from "$lib/components/BusyIndicator.svelte";
  import ChatView from "$lib/components/ChatView.svelte";
  import Composer from "$lib/components/Composer.svelte";
  import ConversationsRail from "$lib/components/ConversationsRail.svelte";
  import GroupsRail from "$lib/components/GroupsRail.svelte";
  import JumpPalette, { type JumpItem } from "$lib/components/JumpPalette.svelte";
  import SessionsRail from "$lib/components/SessionsRail.svelte";
  import SessionTerminal from "$lib/components/SessionTerminal.svelte";
  import ToastStack from "$lib/components/ToastStack.svelte";
  import {
    cycleFocusRegion,
    focusRegion,
    isRenameInput,
    isTypingContext,
    jumpPaletteOpen,
    selectedConversationId,
    selectedGroupId,
    selectedSessionId,
    setFocusRegion,
  } from "$lib/focus";
  import { matchAction, type ActionId } from "$lib/keybindings";
  import {
    railWidths,
    railWidthsStyle,
    setRailWidth,
    type RailWidths,
  } from "$lib/railWidths";
  import {
    activeConversationId,
    activeGroup,
    activeGroupConversations,
    activeGroupId,
    activeMessages,
    activeSessionId,
    activeSessions,
    activeTurn,
    activeTurns,
    backendError,
    chordFor,
    connected,
    conversations,
    expandedSessionId,
    groups,
    keybindings,
    moveConversation,
    moveGroup,
    renameConversation,
    renameGroup,
    reorderConversation,
    reorderGroup,
    sessions,
    setActiveConversation,
    setActiveGroup,
    setGroupColor,
    setKeybindings,
    stickySessionId,
  } from "$lib/stores";
  import {
    closeExpandedSession,
    closeSession,
    controlFromKeyboard,
    createConversationWithSession,
    createGroupWithWorkspace,
    createSession,
    deleteConversation,
    deleteGroup,
    initSessionBridge,
    openExpandedSession,
    persistAppStateNow,
    renameSession,
    sendCommand,
    sendControlToTargets,
    teardownSessionBridge,
  } from "$lib/sessionBridge";

  let bootError = $state<string | null>(null);
  let booting = $state(true);
  let creatingSession = $state(false);
  let creatingConversation = $state(false);
  let creatingGroup = $state(false);
  let renameTargetId = $state<string | null>(null);
  let renameConvoTargetId = $state<string | null>(null);
  let renameGroupTargetId = $state<string | null>(null);

  /** Prevent re-entrant close handling while we confirm/save/destroy. */
  let closingApp = $state(false);

  /** Drag-resize rails (convos / sessions; groups optional). */
  let resizing: { key: keyof RailWidths; startX: number; startW: number } | null =
    $state(null);

  function onResizePointerDown(
    e: PointerEvent,
    key: keyof RailWidths,
    edge: "left" | "right",
  ) {
    e.preventDefault();
    const startW = get(railWidths)[key];
    resizing = { key, startX: e.clientX, startW };
    const target = e.currentTarget as HTMLElement;
    target.setPointerCapture(e.pointerId);
    const onMove = (ev: PointerEvent) => {
      if (!resizing) return;
      const dx = ev.clientX - resizing.startX;
      // Right edge of left rails: drag right = wider. Left edge of sessions: drag left = wider.
      const delta = edge === "right" ? dx : -dx;
      setRailWidth(resizing.key, resizing.startW + delta);
    };
    const onUp = (ev: PointerEvent) => {
      target.releasePointerCapture(ev.pointerId);
      target.removeEventListener("pointermove", onMove);
      target.removeEventListener("pointerup", onUp);
      target.removeEventListener("pointercancel", onUp);
      resizing = null;
    };
    target.addEventListener("pointermove", onMove);
    target.addEventListener("pointerup", onUp);
    target.addEventListener("pointercancel", onUp);
  }

  function activeBlockingSessions() {
    return get(sessions).filter(
      (s) =>
        s.activity === "busy" ||
        s.activity === "tui" ||
        !!s.tuiActive ||
        get(activeTurns).has(s.id),
    );
  }

  onMount(() => {
    let cancelled = false;
    let unlistenClose: (() => void) | undefined;

    void (async () => {
      try {
        // Load keybindings before (or alongside) session boot.
        try {
          await invoke<string>("ensure_keybindings_config").catch(() => null);
          const kb = await invoke<{
            bindings: Record<string, string>;
            sourcePath?: string | null;
            configDir?: string | null;
          }>("get_keybindings");
          if (!cancelled) {
            setKeybindings(kb.bindings, {
              sourcePath: kb.sourcePath ?? null,
              configDir: kb.configDir ?? null,
            });
          }
        } catch {
          /* keep frontend defaults */
        }

        await initSessionBridge();
      } catch (err) {
        if (!cancelled) bootError = String(err);
      } finally {
        if (!cancelled) booting = false;
      }

      // Intercept window close (titlebar X, Super+Q, etc.). beforeunload is
      // unreliable in Tauri/WebKitGTK.
      try {
        const win = getCurrentWindow();
        unlistenClose = await win.onCloseRequested(async (event) => {
          if (closingApp) return;
          event.preventDefault();

          const blocking = activeBlockingSessions();
          if (blocking.length > 0) {
            const names = blocking
              .map((s) => {
                const kind =
                  s.activity === "tui" || s.tuiActive
                    ? "TUI"
                    : s.activity === "busy"
                      ? "busy"
                      : "active";
                return `@${s.name} (${kind})`;
              })
              .join(", ");
            const ok = window.confirm(
              `${blocking.length} session(s) still active:\n${names}\n\n` +
                `Quit anyway? Local shells and TUIs will be killed. Chat history will be saved.`,
            );
            if (!ok) return;
          }

          closingApp = true;
          try {
            await persistAppStateNow();
          } catch (err) {
            console.error("persist on quit failed", err);
          }
          try {
            await win.destroy();
          } catch (err) {
            console.error("destroy window failed", err);
            // Fallback: try close()
            try {
              await win.close();
            } catch {
              /* ignore */
            }
            closingApp = false;
          }
        });
      } catch (err) {
        console.error("onCloseRequested setup failed", err);
      }
    })();

    // Keep selection in sync with active entities when they change.
    const unsubGroup = activeGroupId.subscribe((id) => {
      if (id) selectedGroupId.set(id);
    });
    const unsubConvo = activeConversationId.subscribe((id) => {
      if (id) selectedConversationId.set(id);
    });
    const unsubSess = activeSessionId.subscribe((id) => {
      if (id) selectedSessionId.set(id);
    });

    const onKeydown = (e: KeyboardEvent) => {
      if (booting) return;

      const inRename = isRenameInput(e.target);
      if (inRename) return;

      const inField = isTypingContext(e.target);
      const paletteOpen = get(jumpPaletteOpen);
      const region = get(focusRegion);

      // Esc stack (Discord-like)
      if (e.key === "Escape") {
        if (paletteOpen) {
          e.preventDefault();
          jumpPaletteOpen.set(false);
          return;
        }
        if (renameTargetId || renameConvoTargetId || renameGroupTargetId) {
          e.preventDefault();
          renameTargetId = null;
          renameConvoTargetId = null;
          renameGroupTargetId = null;
          return;
        }
        if (get(expandedSessionId)) {
          e.preventDefault();
          closeExpandedSession();
          setFocusRegion("sessions");
          return;
        }
        if (inField && region === "composer") {
          e.preventDefault();
          (e.target as HTMLElement)?.blur?.();
          setFocusRegion("sessions");
          return;
        }
      }

      // Tab ONLY cycles rails + composer — never nested buttons/pencils.
      // Always preventDefault so the browser can't tab into chrome.
      if (e.key === "Tab" && !paletteOpen && !get(expandedSessionId) && !inRename) {
        e.preventDefault();
        e.stopPropagation();
        cycleFocusRegion(e.shiftKey ? -1 : 1);
        return;
      }

      const bindings = get(keybindings);
      const action = matchAction(e, bindings);

      if (action) {
        if (
          inField &&
          !e.altKey &&
          !e.metaKey &&
          action !== "focusComposer" &&
          action !== "jumpPalette" &&
          action !== "focusGroups" &&
          action !== "focusConversations" &&
          action !== "focusSessions"
        ) {
          return;
        }
        e.preventDefault();
        e.stopPropagation();
        void runAction(action);
        return;
      }

      // List navigation when a rail is focused and not typing
      if (
        !paletteOpen &&
        !inField &&
        !get(expandedSessionId) &&
        (region === "groups" ||
          region === "conversations" ||
          region === "sessions")
      ) {
        if (handleRailNavKey(e, region)) {
          e.preventDefault();
          e.stopPropagation();
          return;
        }
      }

      if (!get(connected)) return;

      if (get(expandedSessionId)) return;

      const ctrl = controlFromKeyboard(e);
      if (!ctrl) return;
      e.preventDefault();
      e.stopPropagation();
      const composerText =
        document.querySelector<HTMLInputElement>("[data-composer-input]")?.value ??
        null;
      void sendControlToTargets(ctrl.label, ctrl.byte, composerText).catch(
        (err) => {
          backendError.set(String(err));
        },
      );
    };
    window.addEventListener("keydown", onKeydown, true);

    return () => {
      cancelled = true;
      window.removeEventListener("keydown", onKeydown, true);
      unsubGroup();
      unsubConvo();
      unsubSess();
      unlistenClose?.();
      void teardownSessionBridge();
    };
  });

  function handleRailNavKey(
    e: KeyboardEvent,
    region: "groups" | "conversations" | "sessions",
  ): boolean {
    const key = e.key;
    const down =
      key === "ArrowDown" || key === "j" || key === "J";
    const up = key === "ArrowUp" || key === "k" || key === "K";
    const home = key === "Home";
    const end = key === "End";
    const enter = key === "Enter";
    if (!down && !up && !home && !end && !enter) return false;
    if (e.altKey || e.metaKey || e.ctrlKey) return false;

    if (region === "groups") {
      const list = get(groups);
      if (list.length === 0) return true;
      let idx = list.findIndex((g) => g.id === get(selectedGroupId));
      if (idx < 0) idx = list.findIndex((g) => g.id === get(activeGroupId));
      if (idx < 0) idx = 0;
      if (enter) {
        const id = list[idx]?.id;
        if (id) setActiveGroup(id);
        return true;
      }
      if (home) idx = 0;
      else if (end) idx = list.length - 1;
      else if (down) idx = Math.min(list.length - 1, idx + 1);
      else if (up) idx = Math.max(0, idx - 1);
      selectedGroupId.set(list[idx]!.id);
      return true;
    }

    if (region === "conversations") {
      const list = get(activeGroupConversations);
      if (list.length === 0) return true;
      let idx = list.findIndex((c) => c.id === get(selectedConversationId));
      if (idx < 0) idx = list.findIndex((c) => c.id === get(activeConversationId));
      if (idx < 0) idx = 0;
      if (enter) {
        const id = list[idx]?.id;
        if (id) setActiveConversation(id);
        return true;
      }
      if (home) idx = 0;
      else if (end) idx = list.length - 1;
      else if (down) idx = Math.min(list.length - 1, idx + 1);
      else if (up) idx = Math.max(0, idx - 1);
      selectedConversationId.set(list[idx]!.id);
      return true;
    }

    // sessions
    {
      const list = get(activeSessions);
      if (list.length === 0) return true;
      let idx = list.findIndex((s) => s.id === get(selectedSessionId));
      if (idx < 0) idx = list.findIndex((s) => s.id === get(activeSessionId));
      if (idx < 0) idx = 0;
      if (enter) {
        const id = list[idx]?.id;
        if (id) {
          activeSessionId.set(id);
          stickySessionId.set(id);
          selectedSessionId.set(id);
        }
        return true;
      }
      if (home) idx = 0;
      else if (end) idx = list.length - 1;
      else if (down) idx = Math.min(list.length - 1, idx + 1);
      else if (up) idx = Math.max(0, idx - 1);
      selectedSessionId.set(list[idx]!.id);
      return true;
    }
  }

  async function runAction(action: ActionId) {
    switch (action) {
      case "toggleTerminal": {
        const expanded = get(expandedSessionId);
        if (expanded) {
          closeExpandedSession();
          return;
        }
        const id =
          get(selectedSessionId) ??
          get(activeSessionId) ??
          get(stickySessionId) ??
          get(activeSessions)[0]?.id ??
          null;
        if (id) openExpandedSession(id);
        return;
      }
      case "newSession":
        await handleFocusAwareNew();
        return;
      case "closeSession":
        await handleFocusAwareClose();
        return;
      case "renameSession":
      case "renameItem":
        handleFocusAwareRename();
        return;
      case "jumpPalette":
        jumpPaletteOpen.set(true);
        setFocusRegion("palette");
        return;
      case "focusGroups":
        setFocusRegion("groups");
        return;
      case "focusConversations":
        setFocusRegion("conversations");
        return;
      case "focusSessions":
        setFocusRegion("sessions");
        return;
      case "focusComposer":
        closeExpandedSession();
        setFocusRegion("composer");
        return;
      case "nextSession":
        cycleSession(1);
        return;
      case "prevSession":
        cycleSession(-1);
        return;
      case "session1":
      case "session2":
      case "session3":
      case "session4":
      case "session5":
      case "session6":
      case "session7":
      case "session8":
      case "session9": {
        const n = Number(action.replace("session", ""));
        // Numbered sessions are relative to the active conversation.
        const target = get(activeSessions)[n - 1];
        if (!target) return;
        activeSessionId.set(target.id);
        stickySessionId.set(target.id);
        const expanded = get(expandedSessionId);
        if (expanded === target.id) closeExpandedSession();
        else openExpandedSession(target.id);
        return;
      }
    }
  }

  function cycleSession(delta: number) {
    const list = get(activeSessions);
    if (list.length === 0) return;
    const cur =
      get(expandedSessionId) ?? get(activeSessionId) ?? get(stickySessionId);
    let idx = list.findIndex((s) => s.id === cur);
    if (idx < 0) idx = 0;
    else idx = (idx + delta + list.length) % list.length;
    const target = list[idx]!;
    activeSessionId.set(target.id);
    stickySessionId.set(target.id);
    if (get(expandedSessionId)) openExpandedSession(target.id);
  }

  async function handleSend(text: string) {
    try {
      await sendCommand(text);
    } catch (err) {
      backendError.set(String(err));
    }
  }

  function handleOpenSession(id: string) {
    // Stuck state: expanded id set but session missing → clear and open.
    const list = get(sessions);
    if (!list.some((s) => s.id === id)) {
      closeExpandedSession();
      return;
    }
    if (get(expandedSessionId) === id) {
      closeExpandedSession();
      return;
    }
    openExpandedSession(id);
  }

  async function handleFocusAwareNew() {
    const region = get(focusRegion);
    if (region === "groups") {
      await handleCreateGroup();
      return;
    }
    if (region === "conversations") {
      await handleCreateConversation();
      return;
    }
    await handleCreateSession();
  }

  async function handleFocusAwareClose() {
    const region = get(focusRegion);
    if (region === "groups") {
      const id = get(selectedGroupId) ?? get(activeGroupId);
      if (id) await handleDeleteGroup(id);
      return;
    }
    if (region === "conversations") {
      const id = get(selectedConversationId) ?? get(activeConversationId);
      if (id) await handleDeleteConversation(id);
      return;
    }
    const id =
      get(expandedSessionId) ??
      get(selectedSessionId) ??
      get(activeSessionId) ??
      get(stickySessionId);
    if (id) await handleCloseSession(id);
  }

  function handleFocusAwareRename() {
    const region = get(focusRegion);
    if (region === "groups") {
      const id = get(selectedGroupId) ?? get(activeGroupId);
      if (id) {
        selectedGroupId.set(id);
        setActiveGroup(id);
        renameConvoTargetId = null;
        renameGroupTargetId = id;
        // Rename UI lives on the conversations header (group title).
      }
      return;
    }
    if (region === "conversations") {
      const id = get(selectedConversationId) ?? get(activeConversationId);
      if (id) {
        renameConvoTargetId = id;
        setFocusRegion("conversations");
      }
      return;
    }
    const id =
      get(selectedSessionId) ??
      get(activeSessionId) ??
      get(stickySessionId) ??
      get(activeSessions)[0]?.id;
    if (id) {
      renameTargetId = id;
      setFocusRegion("sessions");
    }
  }

  async function handleCreateSession() {
    if (creatingSession) return;
    creatingSession = true;
    backendError.set(null);
    try {
      const session = await createSession();
      await new Promise<void>((r) => requestAnimationFrame(() => r()));
      activeSessionId.set(session.id);
      selectedSessionId.set(session.id);
    } catch (err) {
      backendError.set(String(err));
    } finally {
      creatingSession = false;
    }
  }

  function handleJumpPick(item: JumpItem) {
    jumpPaletteOpen.set(false);
    if (item.kind === "group" && item.groupId) {
      setActiveGroup(item.groupId);
      selectedGroupId.set(item.groupId);
      setFocusRegion("groups");
      return;
    }
    if (item.kind === "conversation" && item.conversationId) {
      if (item.groupId) setActiveGroup(item.groupId);
      setActiveConversation(item.conversationId);
      selectedConversationId.set(item.conversationId);
      setFocusRegion("conversations");
      return;
    }
    if (item.kind === "session") {
      if (item.groupId) setActiveGroup(item.groupId);
      if (item.conversationId) setActiveConversation(item.conversationId);
      activeSessionId.set(item.id);
      stickySessionId.set(item.id);
      selectedSessionId.set(item.id);
      setFocusRegion("sessions");
    }
  }

  async function handleCreateConversation() {
    if (creatingConversation) return;
    creatingConversation = true;
    renameConvoTargetId = null;
    backendError.set(null);
    try {
      await createConversationWithSession();
    } catch (err) {
      backendError.set(String(err));
    } finally {
      creatingConversation = false;
    }
  }

  async function handleDeleteConversation(id: string) {
    try {
      if (renameConvoTargetId === id) renameConvoTargetId = null;
      await deleteConversation(id);
    } catch (err) {
      backendError.set(String(err));
    }
  }

  async function handleRenameConversation(id: string, name: string) {
    renameConversation(id, name);
  }

  async function handleCreateGroup() {
    if (creatingGroup) return;
    creatingGroup = true;
    renameConvoTargetId = null;
    backendError.set(null);
    try {
      await createGroupWithWorkspace();
    } catch (err) {
      backendError.set(String(err));
    } finally {
      creatingGroup = false;
    }
  }

  async function handleDeleteGroup(id: string) {
    try {
      await deleteGroup(id);
    } catch (err) {
      backendError.set(String(err));
    }
  }

  async function handleRenameGroup(id: string, name: string) {
    renameGroup(id, name);
  }

  async function handleCloseSession(id: string) {
    try {
      if (renameTargetId === id) renameTargetId = null;
      // closeSession shows warn toasts for busy/TUI; only real errors go red.
      await closeSession(id);
    } catch (err) {
      backendError.set(String(err));
    }
  }

  async function handleRenameSession(id: string, name: string) {
    try {
      await renameSession(id, name);
      backendError.set(null);
    } catch (err) {
      backendError.set(String(err));
      throw err;
    }
  }

  const activeSession = $derived(
    $activeSessionId
      ? ($activeSessions.find((s) => s.id === $activeSessionId) ?? null)
      : ($activeSessions[0] ?? null),
  );

  const expandedSession = $derived(
    $expandedSessionId
      ? ($sessions.find((s) => s.id === $expandedSessionId) ?? null)
      : null,
  );

  /**
   * Bottom bar: long-running line commands only in the *active* conversation.
   * Background convos finish via toast, not this bar.
   */
  const busySessions = $derived(
    $activeSessions.filter((s) => {
      if (s.activity === "tui" || s.tuiActive) return false;
      if (s.activity === "busy") return true;
      const turn = $activeTurns.get(s.id);
      return !!turn && !turn.pausedForTui;
    }),
  );

  /** Prefer sticky/active for the status chip; otherwise first busy. */
  const busySession = $derived(
    busySessions.find((s) => s.id === $activeSessionId) ??
      busySessions.find((s) => s.id === $stickySessionId) ??
      busySessions[0] ??
      null,
  );

  const showBusyBar = $derived(busySessions.length > 0 && !$expandedSessionId);

  const busyExtra = $derived(
    Math.max(0, busySessions.length - (busySession ? 1 : 0)),
  );

  const busyCommand = $derived(
    (busySession && $activeTurns.get(busySession.id)?.command) ??
      $activeTurn?.command ??
      busySession?.lastCommand,
  );
</script>

<div
  class="app"
  class:resizing={!!resizing}
  tabindex="-1"
  style={railWidthsStyle($railWidths)}
>
  <header class="topbar">
    <div class="brand">
      <span class="logo-mark">▶</span>
      <span class="title">Chatty</span>
    </div>
    <div class="status" class:ok={$connected}>
      <span class="dot"></span>
      {#if booting}
        Starting…
      {:else if $connected}
        Connected
      {:else}
        Offline
      {/if}
    </div>
  </header>

  <main class="shell">
    <GroupsRail
      groups={$groups}
      activeId={$activeGroupId}
      selectedId={$selectedGroupId}
      focused={$focusRegion === "groups"}
      conversations={$conversations}
      sessions={$sessions}
      creating={creatingGroup}
      onSelect={(id) => {
        renameConvoTargetId = null;
        renameGroupTargetId = null;
        selectedGroupId.set(id);
        setActiveGroup(id);
      }}
      onHighlight={(id) => selectedGroupId.set(id)}
      onFocusRegion={() => setFocusRegion("groups")}
      onCreate={handleCreateGroup}
      onDelete={handleDeleteGroup}
      onBeginRename={(id) => {
        selectedGroupId.set(id);
        setActiveGroup(id);
        renameConvoTargetId = null;
        renameGroupTargetId = id;
      }}
      onSetColor={(id, color) => setGroupColor(id, color)}
      onReorder={(id, toIndex) => reorderGroup(id, toIndex)}
      onMove={(id, delta) => moveGroup(id, delta)}
    />

    <!-- svelte-ignore a11y_no_noninteractive_element_interactions a11y_no_static_element_interactions -->
    <div
      class="rail-resizer"
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize conversations rail"
      data-edge="right"
      onpointerdown={(e) => onResizePointerDown(e, "convos", "right")}
    ></div>

    <ConversationsRail
      groupName={$activeGroup?.name ?? "Home"}
      groupRenameActive={!!$activeGroupId && renameGroupTargetId === $activeGroupId}
      conversations={$activeGroupConversations}
      activeId={$activeConversationId}
      selectedId={$selectedConversationId}
      focused={$focusRegion === "conversations"}
      sessions={$sessions}
      creating={creatingConversation}
      renameTargetId={renameConvoTargetId}
      onSelect={(id) => {
        renameConvoTargetId = null;
        selectedConversationId.set(id);
        setActiveConversation(id);
      }}
      onHighlight={(id) => selectedConversationId.set(id)}
      onFocusRegion={() => setFocusRegion("conversations")}
      onCreate={handleCreateConversation}
      onDelete={handleDeleteConversation}
      onRename={handleRenameConversation}
      onBeginRename={(id) => {
        renameGroupTargetId = null;
        renameConvoTargetId = id;
      }}
      onCancelRename={() => {
        renameConvoTargetId = null;
      }}
      onRenameGroup={async (name) => {
        const id = get(activeGroupId);
        if (id) await handleRenameGroup(id, name);
      }}
      onBeginGroupRename={() => {
        const id = get(activeGroupId);
        if (!id) return;
        renameConvoTargetId = null;
        renameGroupTargetId = id;
      }}
      onCancelGroupRename={() => {
        renameGroupTargetId = null;
      }}
      onReorder={(id, toIndex) => reorderConversation(id, toIndex)}
      onMove={(id, delta) => moveConversation(id, delta)}
    />

    <!-- svelte-ignore a11y_no_noninteractive_element_interactions a11y_no_static_element_interactions -->
    <div
      class="rail-resizer"
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize sessions rail"
      data-edge="left"
      onpointerdown={(e) => onResizePointerDown(e, "sessions", "left")}
    ></div>

    <section class="chat-pane">
      <div class="pane-header">
        <span class="convo-name">
          {$conversations.find((c) => c.id === $activeConversationId)?.name ??
            "Main"}
          {#if $activeSessions.length > 1}
            <span class="muted-count">· {$activeSessions.length} sessions</span>
          {:else if activeSession}
            <span class="muted-count">· @{activeSession.name}</span>
          {/if}
        </span>
        <span class="badge">mvp2</span>
        {#if activeSession}
          <button
            type="button"
            class="session-hint mono open-session"
            title={`Open session terminal (${chordFor("toggleTerminal")})`}
            onclick={() => handleOpenSession(activeSession.id)}
          >
            @{activeSession.name}
            <span class="hint-key">{chordFor("toggleTerminal")}</span>
          </button>
        {/if}
      </div>

      {#if bootError || $backendError}
        <div class="error mono">{bootError ?? $backendError}</div>
      {/if}

      <div class="chat-body">
        {#key $activeConversationId}
          <ChatView messages={$activeMessages} onOpenSession={handleOpenSession} />
        {/key}
        <ToastStack />
      </div>

      {#if showBusyBar && busySession}
        <BusyIndicator
          sessionName={busySession.name}
          command={busyExtra > 0
            ? `${busyCommand ?? ""}${busyCommand ? " · " : ""}+${busyExtra} more`
            : busyCommand}
          mode="busy"
          onOpen={() => handleOpenSession(busySession.id)}
        />
      {/if}

      <!-- Absolute over chat-pane only — no grid reflow / slide animation -->
      {#if expandedSession}
        {#key expandedSession.id}
          <SessionTerminal sessionId={expandedSession.id} sessionName={expandedSession.name} />
        {/key}
      {/if}
    </section>

    <SessionsRail
      sessions={$activeSessions}
      activeId={$activeSessionId}
      selectedId={$selectedSessionId}
      focused={$focusRegion === "sessions"}
      expandedId={$expandedSessionId}
      creating={creatingSession}
      renameTargetId={renameTargetId}
      canRemove={true}
      onOpen={handleOpenSession}
      onHighlight={(id) => selectedSessionId.set(id)}
      onFocusRegion={() => setFocusRegion("sessions")}
      onCreate={handleCreateSession}
      onClose={handleCloseSession}
      onRename={handleRenameSession}
      onBeginRename={(id) => {
        renameTargetId = id;
      }}
      onCancelRename={() => {
        renameTargetId = null;
      }}
    />
  </main>

  <Composer
    disabled={booting || !$connected}
    onSend={handleSend}
  />

  <JumpPalette
    open={$jumpPaletteOpen}
    groups={$groups}
    conversations={$conversations}
    sessions={$sessions}
    onClose={() => {
      jumpPaletteOpen.set(false);
      setFocusRegion("sessions");
    }}
    onPick={handleJumpPick}
  />
</div>

<style>
  /*
   * Desktop shell: 100vh + named grid.
   *
   *   "top"    "top"    "top"      "top"
   *   "groups" "convos" "chatTop"  "sessionRail"
   *   "groups" "convos" "composer" "composer"
   */
  .app {
    --w-groups: 52px;
    --w-convos: 200px;
    --w-sessions: 240px;
    position: fixed;
    inset: 0;
    width: 100%;
    height: 100vh;
    overflow: hidden;
    display: grid;
    /* groups | convos | handle | chat | handle | sessions — handles are thin columns */
    grid-template-columns:
      var(--w-groups)
      var(--w-convos)
      5px
      minmax(0, 1fr)
      5px
      var(--w-sessions);
    grid-template-rows: auto minmax(0, 1fr) auto;
    grid-template-areas:
      "top     top     top  top      top  top"
      "groups  convos  r1   chatTop  r2   sessionRail"
      "groups  convos  r1   composer composer composer";
    background: var(--bg, #0f1115);
    color: var(--text, #e8eaed);
  }

  .app.resizing {
    cursor: col-resize;
    user-select: none;
  }

  .app.resizing * {
    cursor: col-resize !important;
  }

  .rail-resizer {
    width: 5px;
    margin: 0;
    padding: 0;
    border: none;
    background: transparent;
    cursor: col-resize;
    z-index: 5;
    position: relative;
    align-self: stretch;
  }

  .rail-resizer[data-edge="right"] {
    grid-area: r1;
  }

  .rail-resizer[data-edge="left"] {
    grid-area: r2;
  }

  .rail-resizer::after {
    content: "";
    position: absolute;
    top: 0;
    bottom: 0;
    left: 1px;
    width: 1px;
    background: var(--border, #232833);
    opacity: 0.7;
  }

  .rail-resizer:hover::after,
  .app.resizing .rail-resizer:hover::after {
    background: var(--accent, #4c8dff);
    opacity: 1;
    width: 2px;
    left: 1px;
  }

  .topbar {
    grid-area: top;
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0.75rem 1rem;
    border-bottom: 1px solid var(--border, #232833);
    background: var(--bg-panel, #12151c);
  }

  /* Children of .shell become .app grid items */
  .shell {
    display: contents;
  }

  .shell > :global(aside.groups-rail) {
    grid-area: groups;
    min-height: 0;
    min-width: 0;
    overflow: hidden;
    z-index: 2;
  }

  .shell > :global(aside.conversations-rail) {
    grid-area: convos;
    min-height: 0;
    min-width: 0;
    overflow: hidden;
    z-index: 2;
  }

  .chat-pane {
    grid-area: chatTop;
    position: relative;
    min-height: 0;
    min-width: 0;
    display: flex;
    flex-direction: column;
    overflow: hidden;
    background: var(--bg, #0f1115);
  }

  /* SessionsRail root is <aside class="sessions-rail"> */
  .shell > :global(aside.sessions-rail) {
    grid-area: sessionRail;
    min-height: 0;
    min-width: 0;
    overflow: hidden;
    z-index: 2;
  }

  /* Terminal fills chat-pane only (position:absolute on .overlay itself) */
  .chat-pane > :global(.overlay) {
    z-index: 30;
  }

  /* Composer root is .composer-wrap from the child component */
  .app > :global(.composer-wrap) {
    grid-area: composer;
    min-width: 0;
  }

  .brand {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    font-weight: 600;
  }

  .logo-mark {
    color: var(--accent, #4c8dff);
    font-size: 0.85rem;
  }

  .status {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    font-size: 0.85rem;
    color: var(--muted, #8b93a7);
  }

  .status.ok {
    color: var(--ok, #3dd68c);
  }

  .dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--muted, #8b93a7);
    display: inline-block;
  }

  .status.ok .dot {
    background: var(--ok, #3dd68c);
    box-shadow: 0 0 8px color-mix(in srgb, var(--ok, #3dd68c) 60%, transparent);
  }

  .chat-body {
    position: relative;
    flex: 1 1 0;
    min-height: 0;
    display: flex;
    flex-direction: column;
    overflow: hidden;
    background: var(--bg, #0f1115);
  }

  .pane-header {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.75rem 1rem;
    border-bottom: 1px solid var(--border, #232833);
    font-size: 0.9rem;
    color: var(--muted, #8b93a7);
    flex-shrink: 0;
  }

  .convo-name {
    color: var(--text, #e8eaed);
    font-weight: 600;
  }

  .muted-count {
    font-weight: 500;
    color: var(--muted, #8b93a7);
    font-size: 0.85em;
  }

  .badge {
    font-size: 0.7rem;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    padding: 0.15rem 0.4rem;
    border-radius: 999px;
    background: var(--accent-soft, #2a4a86);
    color: #cfe0ff;
  }

  .session-hint {
    margin-left: auto;
    font-size: 0.78rem;
  }

  .open-session {
    display: inline-flex;
    align-items: center;
    gap: 0.45rem;
    border: 1px solid transparent;
    background: transparent;
    color: var(--muted, #8b93a7);
    font: inherit;
    cursor: pointer;
    padding: 0.2rem 0.45rem;
    border-radius: 6px;
  }

  .open-session:hover {
    color: var(--text, #e8eaed);
    border-color: var(--border, #232833);
    background: var(--bg-elevated, #161a22);
  }

  .hint-key {
    font-size: 0.68rem;
    opacity: 0.7;
    padding: 0.05rem 0.3rem;
    border-radius: 4px;
    border: 1px solid var(--border, #232833);
  }

  .mono {
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  }

  .error {
    margin: 0.75rem 1rem 0;
    padding: 0.65rem 0.85rem;
    border-radius: var(--radius, 10px);
    background: color-mix(in srgb, #e35d6a 15%, var(--bg-elevated, #161a22));
    border: 1px solid color-mix(in srgb, #e35d6a 40%, var(--border, #232833));
    color: #ffb4bc;
    font-size: 0.82rem;
    flex-shrink: 0;
  }
</style>
