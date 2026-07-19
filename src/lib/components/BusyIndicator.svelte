<script lang="ts">
  interface Props {
    sessionName: string;
    command?: string;
    mode?: "busy" | "tui";
    onOpen?: () => void;
  }

  let { sessionName, command, mode = "busy", onOpen }: Props = $props();

  const isTui = $derived(mode === "tui");
</script>

{#if onOpen}
  <button
    type="button"
    class="busy"
    class:tui={isTui}
    class:clickable={true}
    title="Open session (Ctrl+`)"
    onclick={() => onOpen?.()}
  >
    <span class="dots" aria-hidden="true"><span></span><span></span><span></span></span>
    <span class="text">
      {#if isTui}
        <strong class="mono">@{sessionName}</strong> interactive UI
        {#if command}
          <span class="cmd mono">{command}</span>
        {/if}
        <span class="hint">— click or Ctrl+` to open</span>
      {:else}
        <strong class="mono">@{sessionName}</strong> is running
        {#if command}
          <span class="cmd mono">{command}</span>
        {/if}
        <span class="hint">· Ctrl+`</span>
      {/if}
    </span>
  </button>
{:else}
  <div class="busy" class:tui={isTui} role="status" aria-live="polite">
    <span class="dots" aria-hidden="true"><span></span><span></span><span></span></span>
    <span class="text">
      {#if isTui}
        <strong class="mono">@{sessionName}</strong> interactive UI
        {#if command}
          <span class="cmd mono">{command}</span>
        {/if}
      {:else}
        <strong class="mono">@{sessionName}</strong> is running
        {#if command}
          <span class="cmd mono">{command}</span>
        {/if}
      {/if}
    </span>
  </div>
{/if}

<style>
  .busy {
    display: flex;
    align-items: center;
    gap: 0.55rem;
    width: 100%;
    padding: 0.4rem 1rem 0.55rem;
    font-size: 0.8rem;
    font: inherit;
    color: var(--muted, #8b93a7);
    border: none;
    border-top: 1px solid var(--border, #232833);
    background: color-mix(in srgb, var(--accent, #4c8dff) 8%, var(--bg-panel, #12151c));
    text-align: left;
  }

  .busy.clickable {
    cursor: pointer;
  }

  .busy.clickable:hover {
    filter: brightness(1.08);
  }

  .busy.tui {
    background: color-mix(in srgb, #c792ea 10%, var(--bg-panel, #12151c));
  }

  .text {
    display: flex;
    align-items: baseline;
    gap: 0.4rem;
    flex-wrap: wrap;
  }

  strong {
    font-weight: 600;
    color: var(--text, #e8eaed);
  }

  .cmd {
    opacity: 0.85;
    max-width: 28rem;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .cmd::before {
    content: "· ";
    opacity: 0.5;
  }

  .hint {
    opacity: 0.7;
    font-size: 0.75rem;
  }

  .mono {
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  }

  .dots {
    display: inline-flex;
    gap: 3px;
    align-items: center;
  }

  .dots span {
    width: 5px;
    height: 5px;
    border-radius: 50%;
    background: var(--accent, #4c8dff);
    animation: bounce 1.2s infinite ease-in-out;
  }

  .busy.tui .dots span {
    background: #c792ea;
  }

  .dots span:nth-child(2) {
    animation-delay: 0.15s;
  }

  .dots span:nth-child(3) {
    animation-delay: 0.3s;
  }

  @keyframes bounce {
    0%,
    80%,
    100% {
      opacity: 0.25;
      transform: translateY(0);
    }
    40% {
      opacity: 1;
      transform: translateY(-2px);
    }
  }
</style>
