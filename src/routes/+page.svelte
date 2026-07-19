<script lang="ts">
  import { onMount } from "svelte";
  import { get } from "svelte/store";
  import BusyIndicator from "$lib/components/BusyIndicator.svelte";
  import ChatView from "$lib/components/ChatView.svelte";
  import Composer from "$lib/components/Composer.svelte";
  import SessionsRail from "$lib/components/SessionsRail.svelte";
  import SessionTerminal from "$lib/components/SessionTerminal.svelte";
  import {
    activeSessionId,
    activeTurn,
    backendError,
    connected,
    expandedSessionId,
    messages,
    sessions,
  } from "$lib/stores";
  import {
    closeExpandedSession,
    controlFromKeyboard,
    initSessionBridge,
    openExpandedSession,
    sendCommand,
    sendControl,
    teardownSessionBridge,
  } from "$lib/sessionBridge";

  let bootError = $state<string | null>(null);
  let booting = $state(true);

  onMount(() => {
    let cancelled = false;
    void (async () => {
      try {
        await initSessionBridge();
      } catch (err) {
        if (!cancelled) bootError = String(err);
      } finally {
        if (!cancelled) booting = false;
      }
    })();

    const onKeydown = (e: KeyboardEvent) => {
      if (booting || !get(connected)) return;

      // Ctrl+` (backtick) — toggle sticky/active session terminal
      // Also accept Ctrl+Shift+` (some layouts) and Ctrl+'
      const isToggleSession =
        (e.ctrlKey || e.metaKey) &&
        !e.altKey &&
        (e.key === "`" || e.code === "Backquote" || e.key === "'");
      if (isToggleSession) {
        e.preventDefault();
        e.stopPropagation();
        const expanded = get(expandedSessionId);
        if (expanded) {
          closeExpandedSession();
          return;
        }
        const id =
          get(activeSessionId) ??
          get(sessions)[0]?.id ??
          null;
        if (id) openExpandedSession(id);
        return;
      }

      // Alt+1..9 — open Nth session
      if (e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey) {
        const n = Number(e.key);
        if (n >= 1 && n <= 9) {
          const list = get(sessions);
          const target = list[n - 1];
          if (target) {
            e.preventDefault();
            const expanded = get(expandedSessionId);
            if (expanded === target.id) closeExpandedSession();
            else openExpandedSession(target.id);
          }
          return;
        }
      }

      if (get(expandedSessionId)) return;

      const ctrl = controlFromKeyboard(e);
      if (!ctrl) return;
      e.preventDefault();
      e.stopPropagation();
      void sendControl(ctrl.label, ctrl.byte).catch((err) => {
        backendError.set(String(err));
      });
    };
    window.addEventListener("keydown", onKeydown, true);

    return () => {
      cancelled = true;
      window.removeEventListener("keydown", onKeydown, true);
      void teardownSessionBridge();
    };
  });

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

  const expandedSession = $derived(
    $expandedSessionId
      ? ($sessions.find((s) => s.id === $expandedSessionId) ?? null)
      : null,
  );

  const busySession = $derived(
    $activeTurn
      ? ($sessions.find((s) => s.id === $activeTurn.sessionId) ?? null)
      : $sessions.find((s) => s.activity === "busy" || s.activity === "tui") ?? null,
  );

  const busyMode = $derived<"busy" | "tui">(
    busySession?.activity === "tui" || busySession?.tuiActive
      ? "tui"
      : "busy",
  );

  const showBusyBar = $derived(
    !!busySession &&
      (busySession.activity === "busy" ||
        busySession.activity === "tui" ||
        !!$activeTurn),
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
        <span class="convo-name">local</span>
        <span class="badge">mvp</span>
        {#if $activeSessionId}
          <button
            type="button"
            class="session-hint mono open-session"
            title="Open session terminal (Ctrl+`)"
            onclick={() => handleOpenSession($activeSessionId!)}
          >
            @{$sessions.find((s) => s.id === $activeSessionId)?.name ?? "local"}
            <span class="hint-key">Ctrl+`</span>
          </button>
        {/if}
      </div>

      {#if bootError || $backendError}
        <div class="error mono">{bootError ?? $backendError}</div>
      {/if}

      <div class="chat-body">
        <ChatView messages={$messages} onOpenSession={handleOpenSession} />
        {#if expandedSession}
          <SessionTerminal sessionId={expandedSession.id} sessionName={expandedSession.name} />
        {/if}
      </div>

      {#if showBusyBar && !$expandedSessionId}
        <BusyIndicator
          sessionName={busySession?.name ?? "local"}
          command={$activeTurn?.command ?? busySession?.lastCommand}
          mode={busyMode}
          onOpen={() => {
            const id = busySession?.id ?? $activeSessionId;
            if (id) handleOpenSession(id);
          }}
        />
      {/if}
    </section>

    <SessionsRail
      sessions={$sessions}
      activeId={$activeSessionId}
      expandedId={$expandedSessionId}
      onOpen={handleOpenSession}
    />
  </main>

  <Composer
    disabled={booting || !$connected}
    onSend={handleSend}
  />
</div>

<style>
  :global(html, body) {
    margin: 0;
    height: 100%;
    background: var(--bg);
    color: var(--text);
  }

  :global(body) {
    font-family:
      Inter,
      system-ui,
      -apple-system,
      Segoe UI,
      Roboto,
      sans-serif;
  }

  :global(:root) {
    --bg: #0f1115;
    --bg-elevated: #161a22;
    --bg-panel: #12151c;
    --border: #232833;
    --text: #e8eaed;
    --muted: #8b93a7;
    --accent: #4c8dff;
    --accent-soft: #2a4a86;
    --ok: #3dd68c;
    --idle: #f0b429;
    --radius: 10px;
  }

  .app {
    display: grid;
    grid-template-rows: auto 1fr auto;
    height: 100vh;
    min-height: 100vh;
    background: var(--bg);
  }

  .topbar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0.75rem 1rem;
    border-bottom: 1px solid var(--border);
    background: var(--bg-panel);
  }

  .brand {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    font-weight: 600;
  }

  .logo-mark {
    color: var(--accent);
    font-size: 0.85rem;
  }

  .status {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    font-size: 0.85rem;
    color: var(--muted);
  }

  .status.ok {
    color: var(--ok);
  }

  .dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--muted);
    display: inline-block;
  }

  .status.ok .dot {
    background: var(--ok);
    box-shadow: 0 0 8px color-mix(in srgb, var(--ok) 60%, transparent);
  }

  .shell {
    position: relative;
    display: grid;
    grid-template-columns: 1fr 220px;
    min-height: 0;
  }

  .chat-pane {
    position: relative;
    min-height: 0;
    display: flex;
    flex-direction: column;
  }

  .chat-body {
    position: relative;
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
  }

  .pane-header {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.75rem 1rem;
    border-bottom: 1px solid var(--border);
    font-size: 0.9rem;
    color: var(--muted);
  }

  .convo-name {
    color: var(--text);
    font-weight: 600;
  }

  .badge {
    font-size: 0.7rem;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    padding: 0.15rem 0.4rem;
    border-radius: 999px;
    background: var(--accent-soft);
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
    color: var(--muted);
    font: inherit;
    cursor: pointer;
    padding: 0.2rem 0.45rem;
    border-radius: 6px;
  }

  .open-session:hover {
    color: var(--text);
    border-color: var(--border);
    background: var(--bg-elevated);
  }

  .hint-key {
    font-size: 0.68rem;
    opacity: 0.7;
    padding: 0.05rem 0.3rem;
    border-radius: 4px;
    border: 1px solid var(--border);
  }

  .mono {
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  }

  .error {
    margin: 0.75rem 1rem 0;
    padding: 0.65rem 0.85rem;
    border-radius: var(--radius);
    background: color-mix(in srgb, #e35d6a 15%, var(--bg-elevated));
    border: 1px solid color-mix(in srgb, #e35d6a 40%, var(--border));
    color: #ffb4bc;
    font-size: 0.82rem;
  }
</style>
