<script lang="ts">
  import { onMount } from "svelte";
  import { get } from "svelte/store";
  import { invoke } from "@tauri-apps/api/core";
  import { getCurrentWindow } from "@tauri-apps/api/window";
  import BusyIndicator from "$lib/components/BusyIndicator.svelte";
  import Composer from "$lib/components/Composer.svelte";
  import ConversationsRail from "$lib/components/ConversationsRail.svelte";
  import GroupsRail from "$lib/components/GroupsRail.svelte";
  import type { JumpItem } from "$lib/components/JumpPalette.svelte";
  import MainSurface from "$lib/components/MainSurface.svelte";
  import SessionsRail from "$lib/components/SessionsRail.svelte";
  import SessionTerminal from "$lib/components/SessionTerminal.svelte";
  import ToastStack from "$lib/components/ToastStack.svelte";
  import TopBar from "$lib/components/TopBar.svelte";
  import {
    chromeLayout,
    toggleLeftRails,
    toggleSessionsRail,
  } from "$lib/chromeLayout";
  import {
    beginReplaceFocusedPane,
    closePane,
    focusChatPane,
    focusNextPane,
    focusPaneDirection,
    focusedPaneZoomKey,
    movePaneDirection,
    openSessionInNewPane,
    resizePaneDirection,
    splitFocused,
    swapWithNeighbor,
    termPaneSessionId,
  } from "$lib/mainSurface";
  import {
    APP_ZOOM_STEP,
    nudgeAppZoom,
    nudgePaneZoom,
    PANE_ZOOM_STEP,
    resetAppZoom,
    resetPaneZoom,
    sessionZoomKey,
  } from "$lib/zoom";
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
  import {
    isXtermTarget,
    matchAction,
    TERMINAL_ESCAPE_ACTIONS,
    type ActionId,
  } from "$lib/keybindings";
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
      const inXterm = isXtermTarget(e.target);

      if (action) {
        // Inside a guest TUI/shell: only escape-set actions (don't steal Ctrl+W from vim).
        if (inXterm && !TERMINAL_ESCAPE_ACTIONS.has(action)) {
          return;
        }
        // Typing in composer/inputs: bare letter keys go to the field;
        // Alt/Ctrl chords always run app actions (new session, palette, …).
        if (
          inField &&
          !inXterm &&
          !e.altKey &&
          !e.metaKey &&
          !e.ctrlKey &&
          action !== "focusComposer" &&
          action !== "jumpPalette" &&
          action !== "newSession" &&
          action !== "openInPane" &&
          action !== "replacePaneSession" &&
          action !== "focusGroups" &&
          action !== "focusConversations" &&
          action !== "focusSessions" &&
          !action.startsWith("openSessionInNewPane")
        ) {
          return;
        }
        // Delete = kill session only when sessions rail is focused.
        if (action === "closeSession" && region !== "sessions") {
          return;
        }
        e.preventDefault();
        e.stopPropagation();
        void runAction(action);
        return;
      }

      // Don't steal ↑↓/hjkl from session-type picker or workspace session picker.
      const createMenuOpen = !!document.querySelector("[data-chatty-create-menu]");
      const sessionPickerOpen = !!document.querySelector(".session-picker");

      // List navigation when a rail is focused and not typing
      if (
        !paletteOpen &&
        !createMenuOpen &&
        !sessionPickerOpen &&
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
    // Vim-style + arrows (no modifiers) when a rail has focus.
    const down =
      key === "ArrowDown" || key === "j" || key === "J";
    const up = key === "ArrowUp" || key === "k" || key === "K";
    const home = key === "Home" || key === "g";
    // G for end is shift+g in vim; accept both End and G
    const end = key === "End" || key === "G";
    const enter = key === "Enter";
    // h/l reserved for future horizontal nav; ignore alone so they don't no-op oddly
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
          // Enter = open focused terminal view (not only sticky).
          // hjkl/arrows already move selection; Enter activates like a file manager.
          handleOpenSession(id);
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
      case "openInPane": {
        // Always a new empty pane + session picker (never auto-fill sticky).
        splitFocused("col", { sessionId: null, newKind: "term" });
        return;
      }
      case "replacePaneSession": {
        // Replace focused term via picker (MainSurface tracks Esc restore).
        beginReplaceFocusedPane();
        return;
      }
      case "closePane":
        closePane();
        return;
      case "splitPaneVertical":
        splitFocused("col", {
          sessionId:
            get(selectedSessionId) ??
            get(activeSessionId) ??
            get(stickySessionId) ??
            null,
          newKind: "term",
        });
        return;
      case "splitPaneHorizontal":
        splitFocused("row", {
          sessionId:
            get(selectedSessionId) ??
            get(activeSessionId) ??
            get(stickySessionId) ??
            null,
          newKind: "term",
        });
        return;
      case "focusPaneLeft":
        focusPaneDirection("left");
        return;
      case "focusPaneRight":
        focusPaneDirection("right");
        return;
      case "focusPaneUp":
        focusPaneDirection("up");
        return;
      case "focusPaneDown":
        focusPaneDirection("down");
        return;
      case "resizePaneLeft":
        resizePaneDirection("left");
        return;
      case "resizePaneRight":
        resizePaneDirection("right");
        return;
      case "resizePaneUp":
        resizePaneDirection("up");
        return;
      case "resizePaneDown":
        resizePaneDirection("down");
        return;
      case "swapPaneLeft":
        swapWithNeighbor("left");
        return;
      case "swapPaneRight":
        swapWithNeighbor("right");
        return;
      case "swapPaneUp":
        swapWithNeighbor("up");
        return;
      case "swapPaneDown":
        swapWithNeighbor("down");
        return;
      case "movePaneLeft":
        movePaneDirection("left");
        return;
      case "movePaneRight":
        movePaneDirection("right");
        return;
      case "movePaneUp":
        movePaneDirection("up");
        return;
      case "movePaneDown":
        movePaneDirection("down");
        return;
      case "focusNextPane":
        focusNextPane(1);
        return;
      case "focusPrevPane":
        focusNextPane(-1);
        return;
      case "toggleLeftRails":
        toggleLeftRails();
        return;
      case "toggleSessionsRail":
        toggleSessionsRail();
        return;
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
        // Chat pane + composer are tied: select chat leaf, typing goes to composer.
        closeExpandedSession();
        focusChatPane();
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
      case "openSessionInNewPane1":
      case "openSessionInNewPane2":
      case "openSessionInNewPane3":
      case "openSessionInNewPane4":
      case "openSessionInNewPane5":
      case "openSessionInNewPane6":
      case "openSessionInNewPane7":
      case "openSessionInNewPane8":
      case "openSessionInNewPane9": {
        const n = Number(action.replace("openSessionInNewPane", ""));
        const target = get(activeSessions)[n - 1];
        if (!target) return;
        activeSessionId.set(target.id);
        stickySessionId.set(target.id);
        // Always insert a new pane — never replace.
        openSessionInNewPane(target.id);
        return;
      }
      case "zoomPaneIn": {
        const key = paneZoomTargetKey();
        if (key) nudgePaneZoom(key, PANE_ZOOM_STEP);
        return;
      }
      case "zoomPaneOut": {
        const key = paneZoomTargetKey();
        if (key) nudgePaneZoom(key, -PANE_ZOOM_STEP);
        return;
      }
      case "zoomPaneReset": {
        const key = paneZoomTargetKey();
        if (key) resetPaneZoom(key);
        return;
      }
      case "zoomAppIn":
        nudgeAppZoom(APP_ZOOM_STEP);
        return;
      case "zoomAppOut":
        nudgeAppZoom(-APP_ZOOM_STEP);
        return;
      case "zoomAppReset":
        resetAppZoom();
        return;
    }
  }

  /** Focused workspace pane, or expanded terminal overlay session. */
  function paneZoomTargetKey(): string | null {
    const expanded = get(expandedSessionId);
    if (expanded) return sessionZoomKey(expanded);
    return focusedPaneZoomKey();
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

  function handleSelectSession(id: string) {
    selectedSessionId.set(id);
    activeSessionId.set(id);
    stickySessionId.set(id);
  }

  function handleOpenInPane(id: string) {
    handleSelectSession(id);
    openSessionInNewPane(id);
  }

  function handleOpenSession(id: string) {
    // Stuck state: expanded id set but session missing → clear and open.
    const list = get(sessions);
    if (!list.some((s) => s.id === id)) {
      closeExpandedSession();
      return;
    }
    handleSelectSession(id);
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

  /** Bump to open the session-type picker in SessionsRail (+ / new-session hotkey). */
  let sessionCreateRequest = $state(0);

  function handleCreateSession() {
    if (creatingSession) return;
    // Leave composer/xterm so the profile menu can take focus.
    try {
      (document.activeElement as HTMLElement | null)?.blur?.();
    } catch {
      /* ignore */
    }
    setFocusRegion("sessions");
    sessionCreateRequest += 1;
  }

  async function handleCreateSessionWithProfile(
    profileId: string,
    sshTarget?: string,
  ) {
    if (creatingSession) return;
    creatingSession = true;
    backendError.set(null);
    try {
      const session = await createSession(undefined, {
        profileId,
        sshTarget: sshTarget?.trim() || null,
      });
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

  // Busy bar only when neither focused overlay nor a term pane is showing that work.
  const showBusyBar = $derived(
    busySessions.length > 0 &&
      !$expandedSessionId &&
      !(
        $termPaneSessionId &&
        busySessions.some((s) => s.id === $termPaneSessionId)
      ),
  );

  const convoTitle = $derived(
    $conversations.find((c) => c.id === $activeConversationId)?.name ?? "Main",
  );
  const sessionCountLabel = $derived(
    $activeSessions.length === 0
      ? ""
      : $activeSessions.length === 1
        ? `· 1 session`
        : `· ${$activeSessions.length} sessions`,
  );

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
  class:hide-left-rails={!$chromeLayout.leftRailsVisible}
  class:hide-sessions-rail={!$chromeLayout.sessionsRailVisible}
  tabindex="-1"
  style={railWidthsStyle($railWidths)}
>
  <TopBar
    booting={booting}
    connected={$connected}
    paletteOpen={$jumpPaletteOpen}
    groups={$groups}
    conversations={$conversations}
    sessions={$sessions}
    onPaletteOpenChange={(open) => {
      jumpPaletteOpen.set(open);
      if (open) setFocusRegion("palette");
    }}
    onPick={handleJumpPick}
  />

  <main class="shell">
    <!--
      Each rail lives in a single grid-cell host. Multi-root components
      (aside + menus) must not be direct .shell children — with
      display:contents those extra roots become auto-placed grid items and
      collapse the side rails to full width.
    -->
    <div class="rail-host rail-host-groups">
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
    </div>

    <!-- svelte-ignore a11y_no_noninteractive_element_interactions a11y_no_static_element_interactions -->
    <div
      class="rail-resizer"
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize conversations rail"
      data-edge="right"
      onpointerdown={(e) => onResizePointerDown(e, "convos", "right")}
    ></div>

    <div class="rail-host rail-host-convos">
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
    </div>

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
      {#if bootError || $backendError}
        <div class="error mono">{bootError ?? $backendError}</div>
      {/if}

      <div class="chat-body">
        {#key $activeConversationId}
          <MainSurface
            messages={$activeMessages}
            sessions={$sessions}
            activeSessions={$activeSessions}
            conversationTitle={convoTitle}
            sessionCountLabel={sessionCountLabel}
            onOpenSession={handleOpenSession}
          />
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
          onOpen={() => handleOpenInPane(busySession.id)}
        />
      {/if}

      <!-- Focused single-session terminal — unchanged overlay path -->
      {#if expandedSession}
        {#key expandedSession.id}
          <SessionTerminal
            sessionId={expandedSession.id}
            sessionName={expandedSession.name}
            variant="overlay"
          />
        {/key}
      {/if}
    </section>

    <div class="rail-host rail-host-sessions">
      <SessionsRail
        sessions={$activeSessions}
        activeId={$activeSessionId}
        selectedId={$selectedSessionId}
        focused={$focusRegion === "sessions"}
        expandedId={$expandedSessionId}
        creating={creatingSession}
        renameTargetId={renameTargetId}
        openCreateRequest={sessionCreateRequest}
        canRemove={true}
        onOpen={handleOpenSession}
        onSelect={handleSelectSession}
        onOpenInPane={handleOpenInPane}
        onHighlight={(id) => selectedSessionId.set(id)}
        onFocusRegion={() => setFocusRegion("sessions")}
        onCreate={handleCreateSessionWithProfile}
        onClose={handleCloseSession}
        onRename={handleRenameSession}
        onBeginRename={(id) => {
          renameTargetId = id;
        }}
        onCancelRename={() => {
          renameTargetId = null;
        }}
      />
    </div>
  </main>

  <Composer
    disabled={booting || !$connected}
    onSend={handleSend}
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

  /* Phase 0: collapse chrome rails (independent toggles) */
  .app.hide-left-rails {
    grid-template-columns:
      0
      0
      0
      minmax(0, 1fr)
      5px
      var(--w-sessions);
  }

  .app.hide-left-rails .rail-host-groups,
  .app.hide-left-rails .rail-host-convos,
  .app.hide-left-rails .rail-resizer[data-edge="right"] {
    display: none;
  }

  .app.hide-sessions-rail {
    grid-template-columns:
      var(--w-groups)
      var(--w-convos)
      5px
      minmax(0, 1fr)
      0
      0;
  }

  .app.hide-sessions-rail .rail-host-sessions,
  .app.hide-sessions-rail .rail-resizer[data-edge="left"] {
    display: none;
  }

  .app.hide-left-rails.hide-sessions-rail {
    grid-template-columns:
      0
      0
      0
      minmax(0, 1fr)
      0
      0;
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

  /* TopBar owns grid-area: top via .topbar class on its root */

  /* Children of .shell become .app grid items */
  .shell {
    display: contents;
  }

  /* One grid item per rail — hosts fill the cell; asides stretch inside */
  .rail-host {
    min-height: 0;
    min-width: 0;
    overflow: hidden;
    z-index: 2;
    display: flex;
    flex-direction: column;
  }

  .rail-host-groups {
    grid-area: groups;
  }

  .rail-host-convos {
    grid-area: convos;
  }

  .rail-host-sessions {
    grid-area: sessionRail;
  }

  .rail-host > :global(aside) {
    flex: 1 1 auto;
    min-height: 0;
    min-width: 0;
    width: 100%;
    height: 100%;
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

  /* Focused terminal covers entire main view (header + workspace) */
  .chat-pane > :global(.term-shell.overlay) {
    z-index: 30;
  }

  /* Composer root is .composer-wrap from the child component */
  .app > :global(.composer-wrap) {
    grid-area: composer;
    min-width: 0;
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
