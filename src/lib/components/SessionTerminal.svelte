<script lang="ts">
  import { onDestroy, onMount } from "svelte";
  import { Terminal } from "@xterm/xterm";
  import { FitAddon } from "@xterm/addon-fit";
  import "@xterm/xterm/css/xterm.css";
  import { sessions } from "$lib/stores";
  import {
    closeExpandedSession,
    getPtyScrollback,
    resizeSession,
    sendRawToSession,
    subscribeRawOutput,
  } from "$lib/sessionBridge";

  interface Props {
    sessionId: string;
    sessionName: string;
  }

  let { sessionId, sessionName }: Props = $props();

  const sessionState = $derived($sessions.find((s) => s.id === sessionId));
  const modeLabel = $derived(
    sessionState?.activity === "tui" || sessionState?.tuiActive
      ? "TUI active"
      : sessionState?.activity === "busy"
        ? `running · ${sessionState.lastCommand ?? "…"}`
        : "same shell as chat",
  );

  let host: HTMLDivElement | undefined = $state();
  let term: Terminal | undefined;
  let fit: FitAddon | undefined;
  let unsubRaw: (() => void) | undefined;
  let ro: ResizeObserver | undefined;

  onMount(() => {
    // Defer xterm construction so the overlay chrome paints first.
    let cancelled = false;
    let writeBuf = "";
    let writeScheduled = false;

    const flushWrite = () => {
      writeScheduled = false;
      if (!term || !writeBuf) return;
      const chunk = writeBuf;
      writeBuf = "";
      term.write(chunk);
    };

    const queueWrite = (data: string) => {
      if (!data) return;
      writeBuf += data;
      if (writeScheduled) return;
      writeScheduled = true;
      requestAnimationFrame(flushWrite);
    };

    const boot = () => {
      if (cancelled || !host) return;

      term = new Terminal({
        cursorBlink: true,
        fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
        fontSize: 14,
        lineHeight: 1.2,
        theme: {
          background: "#0d1017",
          foreground: "#e8eaed",
          cursor: "#4c8dff",
          selectionBackground: "#2a4a86",
          black: "#1c2230",
          red: "#e35d6a",
          green: "#3dd68c",
          yellow: "#f0b429",
          blue: "#4c8dff",
          magenta: "#c792ea",
          cyan: "#89ddff",
          white: "#e8eaed",
          brightBlack: "#8b93a7",
        },
        allowProposedApi: true,
        scrollback: 8000,
        convertEol: false,
      });
      fit = new FitAddon();
      term.loadAddon(fit);
      term.open(host);

      // Replay scrollback in rAF-sized chunks so huge login output doesn't freeze.
      const history = getPtyScrollback(sessionId);
      if (history) {
        const CHUNK = 16_384;
        let offset = 0;
        const pump = () => {
          if (cancelled || !term) return;
          if (offset >= history.length) {
            fit?.fit();
            void pushSize();
            term.focus();
            return;
          }
          term.write(history.slice(offset, offset + CHUNK));
          offset += CHUNK;
          requestAnimationFrame(pump);
        };
        requestAnimationFrame(pump);
      } else {
        fit.fit();
        void pushSize();
        term.focus();
      }

      // Single path for keys → PTY. sendRawToSession normalizes Enter to one CR.
      term.onData((data) => {
        void sendRawToSession(sessionId, data).catch(console.error);
      });

      unsubRaw = subscribeRawOutput((id, chunk) => {
        if (id !== sessionId || !term) return;
        queueWrite(chunk);
      });

      // Debounce resize → SIGWINCH; rapid resizes during chat UI updates
      // can confuse zsh line editing (feels like "press Enter twice").
      let resizeTimer: ReturnType<typeof setTimeout> | null = null;
      ro = new ResizeObserver(() => {
        if (resizeTimer) clearTimeout(resizeTimer);
        resizeTimer = setTimeout(() => {
          try {
            fit?.fit();
            void pushSize();
          } catch {
            /* ignore */
          }
        }, 120);
      });
      if (host) ro.observe(host);
    };

    const bootRaf = requestAnimationFrame(boot);

    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        closeExpandedSession();
      }
    };
    window.addEventListener("keydown", onKey, true);

    return () => {
      cancelled = true;
      cancelAnimationFrame(bootRaf);
      window.removeEventListener("keydown", onKey, true);
    };
  });

  onDestroy(() => {
    unsubRaw?.();
    ro?.disconnect();
    term?.dispose();
    term = undefined;
  });

  async function pushSize() {
    if (!term || !fit) return;
    const dims = fit.proposeDimensions();
    const cols = dims?.cols ?? term.cols;
    const rows = dims?.rows ?? term.rows;
    if (cols > 1 && rows > 1) {
      try {
        await resizeSession(sessionId, cols, rows);
      } catch (err) {
        console.error(err);
      }
    }
  }
</script>

<div class="overlay" role="dialog" aria-label={`Session terminal @${sessionName}`}>
  <header class="bar">
    <div class="left">
      <span class="mono">@{sessionName}</span>
      <span
        class="muted"
        class:tui={sessionState?.activity === "tui" || sessionState?.tuiActive}
        class:busy={sessionState?.activity === "busy"}
      >
        {modeLabel}
      </span>
    </div>
    <div class="right">
      <span class="hint">
        {sessionState?.activity === "tui" || sessionState?.tuiActive
          ? "Full-screen app · Esc closes view"
          : "Lines appear in chat · Esc closes view"}
      </span>
      <button type="button" class="close" onclick={() => closeExpandedSession()}>Close</button>
    </div>
  </header>
  <div class="term-host" bind:this={host}></div>
</div>

<style>
  .overlay {
    position: absolute;
    inset: 0;
    z-index: 20;
    display: grid;
    grid-template-rows: auto 1fr;
    background: #0d1017;
    border-right: 1px solid var(--border, #232833);
  }

  .bar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 1rem;
    padding: 0.55rem 0.9rem;
    border-bottom: 1px solid var(--border, #232833);
    background: var(--bg-panel, #12151c);
  }

  .left,
  .right {
    display: flex;
    align-items: center;
    gap: 0.75rem;
  }

  .mono {
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    font-weight: 600;
    color: var(--text, #e8eaed);
  }

  .muted {
    color: var(--muted, #8b93a7);
    font-size: 0.8rem;
  }

  .muted.busy {
    color: var(--accent, #4c8dff);
  }

  .muted.tui {
    color: #c792ea;
    font-weight: 600;
  }

  .hint {
    font-size: 0.75rem;
    color: var(--muted, #8b93a7);
  }

  .close {
    border: 1px solid var(--border, #232833);
    background: var(--bg-elevated, #161a22);
    color: var(--text, #e8eaed);
    border-radius: 8px;
    padding: 0.35rem 0.75rem;
    font: inherit;
    font-size: 0.85rem;
    cursor: pointer;
  }

  .close:hover {
    border-color: var(--accent, #4c8dff);
  }

  .term-host {
    min-height: 0;
    height: 100%;
    padding: 0.35rem 0.45rem 0.45rem;
  }

  .term-host :global(.xterm) {
    height: 100%;
  }

  .term-host :global(.xterm-viewport) {
    overflow-y: auto !important;
  }
</style>
