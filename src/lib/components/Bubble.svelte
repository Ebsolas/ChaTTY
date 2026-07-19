<script lang="ts">
  import type { ChatMessage } from "$lib/types";

  interface Props {
    message: ChatMessage;
    onOpenSession?: (sessionId: string) => void;
  }

  let { message, onOpenSession }: Props = $props();

  const isUser = $derived(message.role === "user");
  const label = $derived(
    isUser ? "You" : `@${message.sessionName ?? "session"}`,
  );
  const badge = $derived(
    message.streamState === "open"
      ? message.turnStatus === "tui"
        ? "tui"
        : "running"
      : message.turnStatus === "tui"
        ? "tui"
        : message.turnStatus === "error"
          ? "err"
          : null,
  );

  function open() {
    if (message.sessionId && onOpenSession) {
      onOpenSession(message.sessionId);
    }
  }
</script>

<div class="row" class:user={isUser} class:session={!isUser}>
  {#if onOpenSession && message.sessionId}
    <button
      type="button"
      class="bubble clickable"
      class:streaming={message.streamState === "open"}
      class:tui={message.turnStatus === "tui"}
      title="Open session terminal (Ctrl+`)"
      onclick={open}
    >
      <div class="meta">
        <span class="label">{label}</span>
        {#if badge === "running"}
          <span class="live">running</span>
        {:else if badge === "tui"}
          <span class="live tui-badge">tui</span>
        {:else if badge === "err"}
          <span class="live err">error</span>
        {/if}
        <span class="open-hint">open ↗</span>
      </div>
      <pre class="body">{message.body || (message.streamState === "open" ? "…" : "")}</pre>
    </button>
  {:else}
    <div
      class="bubble"
      class:streaming={message.streamState === "open"}
      class:tui={message.turnStatus === "tui"}
    >
      <div class="meta">
        <span class="label">{label}</span>
        {#if badge === "running"}
          <span class="live">running</span>
        {:else if badge === "tui"}
          <span class="live tui-badge">tui</span>
        {:else if badge === "err"}
          <span class="live err">error</span>
        {/if}
      </div>
      <pre class="body">{message.body || (message.streamState === "open" ? "…" : "")}</pre>
    </div>
  {/if}
</div>

<style>
  .row {
    display: flex;
    width: 100%;
    margin: 0.4rem 0;
  }

  .row.user {
    justify-content: flex-end;
  }

  .row.session {
    justify-content: flex-start;
  }

  .bubble {
    max-width: min(72%, 44rem);
    border-radius: 12px;
    padding: 0.55rem 0.75rem 0.65rem;
    border: 1px solid var(--border);
    background: var(--bg-elevated);
    font: inherit;
    color: inherit;
    text-align: left;
  }

  button.bubble {
    display: block;
    width: fit-content;
    max-width: min(72%, 44rem);
  }

  .bubble.clickable {
    cursor: pointer;
    transition:
      border-color 0.12s ease,
      box-shadow 0.12s ease,
      filter 0.12s ease;
  }

  .bubble.clickable:hover {
    border-color: color-mix(in srgb, var(--accent) 50%, var(--border));
    box-shadow: 0 0 0 1px color-mix(in srgb, var(--accent) 25%, transparent);
  }

  .bubble.clickable:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 2px;
  }

  .row.user .bubble {
    background: var(--accent);
    border-color: transparent;
    color: #fff;
  }

  .row.user .bubble.clickable:hover {
    filter: brightness(1.06);
    border-color: transparent;
  }

  .row.session .bubble {
    background: #1c2230;
  }

  .bubble.streaming {
    box-shadow: 0 0 0 1px color-mix(in srgb, var(--accent) 35%, transparent);
  }

  .bubble.tui {
    box-shadow: 0 0 0 1px color-mix(in srgb, #c792ea 40%, transparent);
  }

  .meta {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    margin-bottom: 0.25rem;
    font-size: 0.72rem;
    opacity: 0.85;
  }

  .label {
    font-weight: 600;
  }

  .live {
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--ok);
  }

  .live.tui-badge {
    color: #c792ea;
  }

  .live.err {
    color: #e35d6a;
  }

  .row.user .live {
    color: #dce9ff;
  }

  .open-hint {
    margin-left: auto;
    opacity: 0;
    font-size: 0.68rem;
    text-transform: lowercase;
    letter-spacing: 0.02em;
    transition: opacity 0.12s ease;
  }

  .bubble.clickable:hover .open-hint,
  .bubble.clickable:focus-visible .open-hint {
    opacity: 0.75;
  }

  .row.user .open-hint {
    color: #dce9ff;
  }

  .body {
    margin: 0;
    white-space: pre-wrap;
    word-break: break-word;
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    font-size: 0.82rem;
    line-height: 1.45;
  }
</style>
