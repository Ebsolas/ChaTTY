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
  import {
    getPaneZoom,
    paneZooms,
    sessionZoomKey,
    termFontPx,
  } from "$lib/zoom";

  interface Props {
    sessionId: string;
    sessionName: string;
    /**
     * overlay — focused full-pane terminal (Esc closes expanded view).
     * embedded — work-surface pane leaf (Esc does not close; parent owns chrome).
     */
    variant?: "overlay" | "embedded";
    /** Hide title bar (workspace leaves are headerless). */
    bare?: boolean;
    /**
     * Zoom storage key (`pane:…` or `session:…`). Defaults to session key.
     */
    zoomKey?: string;
    onClose?: () => void;
  }

  let {
    sessionId,
    sessionName,
    variant = "overlay",
    bare = false,
    zoomKey = undefined,
    onClose,
  }: Props = $props();

  const resolvedZoomKey = $derived(zoomKey ?? sessionZoomKey(sessionId));
  const paneZoom = $derived($paneZooms[resolvedZoomKey] ?? 1);

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
  /** Fixed for this mount ({#key sessionId} remounts the component). */
  let boundSessionId = "";

  /** Cap open replay — full 500KB rings freeze the UI for hundreds of ms. */
  const OPEN_HISTORY_MAX = 96_000;
  const CHUNK = 48_000;

  onMount(() => {
    boundSessionId = sessionId;
    let cancelled = false;
    let writeBuf = "";
    let writeScheduled = false;
    /**
     * While replaying scrollback, xterm parses historical CSI/OSC queries
     * (DA, CPR, color queries, …) and fires onData with *responses*.
     * If we forward those to the PTY, they land as garbage on the shell line.
     */
    let acceptInput = false;

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

    const doFit = () => {
      if (!term || !fit || !host) return false;
      if (host.clientWidth < 4 || host.clientHeight < 4) return false;
      try {
        fit.fit();
        return true;
      } catch {
        return false;
      }
    };

    const finishOpen = () => {
      if (cancelled || !term) return;
      doFit();
      void pushSize().finally(() => {
        if (cancelled || !term) return;
        // Let any deferred onData from the last history write settle first.
        setTimeout(() => {
          if (cancelled || !term) return;
          acceptInput = true;
          term.focus();
        }, 40);
      });
    };

    /** Wait until the absolute overlay has real layout before opening xterm. */
    const waitForHostSize = (): Promise<void> =>
      new Promise((resolve) => {
        if (cancelled) {
          resolve();
          return;
        }
        const el = host;
        if (!el) {
          resolve();
          return;
        }
        if (el.clientWidth >= 4 && el.clientHeight >= 4) {
          resolve();
          return;
        }
        let settled = false;
        const done = () => {
          if (settled) return;
          settled = true;
          observer.disconnect();
          clearTimeout(timer);
          resolve();
        };
        const observer = new ResizeObserver(() => {
          if (el.clientWidth >= 4 && el.clientHeight >= 4) done();
        });
        observer.observe(el);
        // Fallback so we still boot if layout never reports (shouldn't happen).
        const timer = setTimeout(done, 400);
      });

    const historyForOpen = (): string => {
      let history = getPtyScrollback(boundSessionId);
      if (!history) return "";
      if (history.length > OPEN_HISTORY_MAX) {
        history = history.slice(history.length - OPEN_HISTORY_MAX);
        // Prefer starting at a line boundary so we don't splice mid-escape often.
        const nl = history.indexOf("\n");
        if (nl > 0 && nl < 512) history = history.slice(nl + 1);
      }
      return history;
    };

    const boot = async () => {
      if (cancelled || !host) return;

      await waitForHostSize();
      if (cancelled || !host) return;

      term = new Terminal({
        cursorBlink: true,
        fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
        fontSize: termFontPx(
          getPaneZoom(zoomKey ?? sessionZoomKey(sessionId)),
        ),
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
      // Fit before history so cells match the host; avoids 0-size blank screens.
      doFit();

      // Register early but gate with acceptInput (see above).
      term.onData((data) => {
        if (!acceptInput || cancelled) return;
        void sendRawToSession(boundSessionId, data).catch(console.error);
      });

      unsubRaw = subscribeRawOutput((id, chunk) => {
        if (id !== boundSessionId || !term) return;
        // Buffer live output even during history replay so we don't miss bytes.
        queueWrite(chunk);
      });

      const history = historyForOpen();
      if (history) {
        let offset = 0;
        const pump = () => {
          if (cancelled || !term) return;
          if (offset >= history.length) {
            // One more frame so any onData from the last write is dropped.
            requestAnimationFrame(() => {
              if (!cancelled) finishOpen();
            });
            return;
          }
          // write() is async internally; chain chunks so query responses
          // from earlier chunks still fall under acceptInput === false.
          term.write(history.slice(offset, offset + CHUNK), () => {
            offset += CHUNK;
            requestAnimationFrame(pump);
          });
        };
        requestAnimationFrame(pump);
      } else {
        finishOpen();
      }

      let resizeTimer: ReturnType<typeof setTimeout> | null = null;
      ro = new ResizeObserver(() => {
        if (resizeTimer) clearTimeout(resizeTimer);
        resizeTimer = setTimeout(() => {
          if (cancelled || !term) return;
          // Always reflow the canvas once layout exists — gating on acceptInput
          // left a blank terminal when the first fit ran at zero size.
          if (!doFit()) return;
          if (!acceptInput) return;
          void pushSize();
        }, 80);
      });
      if (host) ro.observe(host);
    };

    const bootRaf = requestAnimationFrame(() => {
      void boot();
    });

    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (variant !== "overlay") return;
      e.preventDefault();
      closeExpandedSession();
    };
    window.addEventListener("keydown", onKey, true);

    return () => {
      cancelled = true;
      acceptInput = false;
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

  // Per-pane / per-session font zoom (Ctrl±); reflow PTY cells after change.
  $effect(() => {
    const z = paneZoom;
    if (!term || !fit) return;
    const px = termFontPx(z);
    if (term.options.fontSize === px) return;
    term.options.fontSize = px;
    try {
      fit.fit();
    } catch {
      /* ignore */
    }
    void pushSize();
  });

  async function pushSize() {
    if (!term || !fit) return;
    const dims = fit.proposeDimensions();
    const cols = dims?.cols ?? term.cols;
    const rows = dims?.rows ?? term.rows;
    if (cols > 1 && rows > 1) {
      try {
        await resizeSession(boundSessionId, cols, rows);
      } catch (err) {
        console.error(err);
      }
    }
  }
</script>

<div
  class="term-shell"
  class:overlay={variant === "overlay"}
  class:embedded={variant === "embedded"}
  class:bare
  role={variant === "overlay" ? "dialog" : "region"}
  aria-label={`Session terminal @${sessionName}`}
>
  {#if !bare}
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
          {#if variant === "embedded"}
            {sessionState?.activity === "tui" || sessionState?.tuiActive
              ? "Pane · TUI · close pane keeps session"
              : "Pane · lines still appear in chat"}
          {:else if sessionState?.activity === "tui" || sessionState?.tuiActive}
            Full-screen app · Esc closes view
          {:else}
            Lines appear in chat · Esc closes view
          {/if}
        </span>
        <button
          type="button"
          class="close"
          onclick={() => {
            if (variant === "embedded") onClose?.();
            else closeExpandedSession();
          }}
        >
          Close
        </button>
      </div>
    </header>
  {/if}
  <div class="term-host" bind:this={host}></div>
</div>

<style>
  .term-shell {
    display: flex;
    flex-direction: column;
    min-height: 0;
    min-width: 0;
    background: #0d1017;
    border: none;
  }

  .term-shell.overlay {
    /* Cover chat-pane only — focused single-session path. */
    position: absolute;
    inset: 0;
    z-index: 30;
  }

  .term-shell.embedded {
    position: relative;
    flex: 1 1 auto;
    min-height: 0;
    width: 100%;
    height: auto;
    border-left: none;
  }

  .term-shell.bare .term-host {
    padding: 0.2rem;
  }

  .bar {
    flex: 0 0 auto;
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
    flex: 1 1 auto;
    min-height: 0;
    min-width: 0;
    position: relative;
    overflow: hidden;
    padding: 0.35rem 0.45rem 0.45rem;
  }

  .term-host :global(.xterm) {
    height: 100%;
    width: 100%;
  }

  .term-host :global(.xterm-viewport) {
    overflow-y: auto !important;
  }
</style>
