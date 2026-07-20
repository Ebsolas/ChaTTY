<script lang="ts">
  import { onMount } from "svelte";
  import { get } from "svelte/store";
  import { invoke } from "@tauri-apps/api/core";
  import BusyIndicator from "$lib/components/BusyIndicator.svelte";
  import ChatView from "$lib/components/ChatView.svelte";
  import Composer from "$lib/components/Composer.svelte";
  import SessionsRail from "$lib/components/SessionsRail.svelte";
  import SessionTerminal from "$lib/components/SessionTerminal.svelte";
  import ToastStack from "$lib/components/ToastStack.svelte";
  import { matchAction, type ActionId } from "$lib/keybindings";
  import {
    activeSessionId,
    activeTurn,
    activeTurns,
    backendError,
    chordFor,
    connected,
    expandedSessionId,
    keybindings,
    messages,
    sessions,
    setKeybindings,
    stickySessionId,
  } from "$lib/stores";
  import {
    closeExpandedSession,
    closeSession,
    controlFromKeyboard,
    createSession,
    initSessionBridge,
    openExpandedSession,
    renameSession,
    sendCommand,
    sendControlToTargets,
    teardownSessionBridge,
  } from "$lib/sessionBridge";

  let bootError = $state<string | null>(null);
  let booting = $state(true);
  let creatingSession = $state(false);
  let renameTargetId = $state<string | null>(null);

  onMount(() => {
    let cancelled = false;
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
    })();

    const onKeydown = (e: KeyboardEvent) => {
      if (booting) return;

      // Don't steal keys while typing a rename.
      const t = e.target as HTMLElement | null;
      const tag = t?.tagName?.toLowerCase();
      const inRename =
        tag === "input" && t?.classList?.contains("rename-input");
      if (inRename) return;

      // When focus is in composer (or other text fields), only honor Alt/Meta chords
      // so normal typing works. Ctrl chords for shell signals still work when not expanded.
      const inField =
        tag === "input" || tag === "textarea" || t?.isContentEditable;

      const bindings = get(keybindings);
      const action = matchAction(e, bindings);

      if (action) {
        // In text fields, ignore bare keys; only allow modified navigation chords.
        if (inField && !e.altKey && !e.metaKey && action !== "focusComposer") {
          return;
        }
        e.preventDefault();
        e.stopPropagation();
        void runAction(action);
        return;
      }

      if (!get(connected)) return;

      // Shell signals (^C, ^Z, …): always allowed — including TUI sessions and
      // while the composer is focused. When the session terminal is open, let
      // xterm deliver the key instead so the focused shell gets it.
      //
      // Targets: leading @mentions in the composer (`@local-2` + Ctrl+C),
      // otherwise sticky/active.
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
      void teardownSessionBridge();
    };
  });

  async function runAction(action: ActionId) {
    switch (action) {
      case "toggleTerminal": {
        const expanded = get(expandedSessionId);
        if (expanded) {
          closeExpandedSession();
          return;
        }
        const id =
          get(activeSessionId) ?? get(stickySessionId) ?? get(sessions)[0]?.id ?? null;
        if (id) openExpandedSession(id);
        return;
      }
      case "newSession":
        await handleCreateSession();
        return;
      case "closeSession": {
        const id =
          get(expandedSessionId) ??
          get(activeSessionId) ??
          get(stickySessionId);
        if (id) await handleCloseSession(id);
        return;
      }
      case "renameSession": {
        const id =
          get(activeSessionId) ?? get(stickySessionId) ?? get(sessions)[0]?.id;
        if (id) renameTargetId = id;
        return;
      }
      case "focusComposer":
        closeExpandedSession();
        document
          .querySelector<HTMLInputElement>("[data-composer-input]")
          ?.focus();
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
        const target = get(sessions)[n - 1];
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
    const list = get(sessions);
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
    if (get(expandedSessionId) === id) {
      closeExpandedSession();
      return;
    }
    openExpandedSession(id);
  }

  async function handleCreateSession() {
    if (creatingSession) return;
    creatingSession = true;
    backendError.set(null);
    try {
      const session = await createSession();
      await new Promise<void>((r) => requestAnimationFrame(() => r()));
      activeSessionId.set(session.id);
    } catch (err) {
      backendError.set(String(err));
    } finally {
      creatingSession = false;
    }
  }

  async function handleCloseSession(id: string) {
    try {
      if (renameTargetId === id) renameTargetId = null;
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
      ? ($sessions.find((s) => s.id === $activeSessionId) ?? null)
      : ($sessions[0] ?? null),
  );

  const expandedSession = $derived(
    $expandedSessionId
      ? ($sessions.find((s) => s.id === $expandedSessionId) ?? null)
      : null,
  );

  /**
   * Bottom bar: long-running line commands only (builds, etc.).
   * TUIs stay in the rail/session view — they are not expected to "finish" here.
   */
  const busySessions = $derived(
    $sessions.filter((s) => {
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

<div class="app" tabindex="-1">
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
    <section class="chat-pane">
      <div class="pane-header">
        <span class="convo-name">
          {#if $sessions.length > 1}
            {$sessions.length} sessions
          {:else}
            {activeSession?.name ?? "local"}
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
        <ChatView messages={$messages} onOpenSession={handleOpenSession} />
        {#if expandedSession}
          {#key expandedSession.id}
            <SessionTerminal sessionId={expandedSession.id} sessionName={expandedSession.name} />
          {/key}
        {/if}
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
    </section>

    <SessionsRail
      sessions={$sessions}
      activeId={$activeSessionId}
      expandedId={$expandedSessionId}
      creating={creatingSession}
      renameTargetId={renameTargetId}
      onOpen={handleOpenSession}
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
</div>

<style>
  .app {
    display: grid;
    grid-template-rows: auto minmax(0, 1fr) auto;
    /* Fill the Tauri webview even if intermediate wrappers lack height */
    position: fixed;
    inset: 0;
    width: 100%;
    height: 100%;
    background: var(--bg, #0f1115);
    color: var(--text, #e8eaed);
  }

  .topbar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0.75rem 1rem;
    border-bottom: 1px solid var(--border, #232833);
    background: var(--bg-panel, #12151c);
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

  .shell {
    position: relative;
    display: grid;
    grid-template-columns: minmax(0, 1fr) 240px;
    min-height: 0;
    overflow: hidden;
  }

  .chat-pane {
    position: relative;
    min-height: 0;
    min-width: 0;
    display: flex;
    flex-direction: column;
    background: var(--bg, #0f1115);
  }

  .chat-body {
    position: relative;
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
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
