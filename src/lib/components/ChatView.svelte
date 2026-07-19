<script lang="ts">
  import type { ChatMessage } from "$lib/types";
  import Bubble from "./Bubble.svelte";

  interface Props {
    messages: ChatMessage[];
    onOpenSession?: (sessionId: string) => void;
  }

  let { messages, onOpenSession }: Props = $props();
  let scroller: HTMLDivElement | undefined = $state();

  $effect(() => {
    // Auto-scroll when messages change.
    void messages;
    if (!scroller) return;
    requestAnimationFrame(() => {
      if (scroller) scroller.scrollTop = scroller.scrollHeight;
    });
  });
</script>

<div class="chat" bind:this={scroller}>
  {#if messages.length === 0}
    <div class="empty">
      <p class="lead">Talk to your local shell</p>
      <p class="muted">
        Send a command below — click a bubble or press <kbd>Ctrl</kbd>+<kbd>`</kbd> to open the
        session terminal.
      </p>
    </div>
  {:else}
    {#each messages as m (m.id)}
      <Bubble message={m} {onOpenSession} />
    {/each}
  {/if}
</div>

<style>
  .chat {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    padding: 1rem 1.1rem 1.25rem;
    display: flex;
    flex-direction: column;
  }

  .empty {
    margin: auto;
    max-width: 28rem;
    text-align: left;
  }

  .lead {
    margin: 0 0 0.5rem;
    font-size: 1.15rem;
    font-weight: 600;
  }

  .muted {
    margin: 0;
    color: var(--muted);
    line-height: 1.5;
  }

  kbd {
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    font-size: 0.8em;
    padding: 0.1em 0.35em;
    border-radius: 4px;
    border: 1px solid var(--border);
    background: var(--bg-elevated);
  }
</style>
