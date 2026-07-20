<script lang="ts">
  import { dismissToast, toasts, type Toast } from "$lib/stores";

  function onDismiss(t: Toast) {
    dismissToast(t.id);
  }
</script>

{#if $toasts.length > 0}
  <div class="toast-stack" aria-live="polite" aria-relevant="additions">
    {#each $toasts as t (t.id)}
      <div class="toast" class:warn={t.level === "warn"} class:info={t.level === "info"} role="status">
        <span class="msg mono">{t.message}</span>
        <button type="button" class="x" aria-label="Dismiss" onclick={() => onDismiss(t)}>×</button>
      </div>
    {/each}
  </div>
{/if}

<style>
  .toast-stack {
    position: absolute;
    right: 0.85rem;
    bottom: 0.85rem;
    z-index: 40;
    display: flex;
    flex-direction: column;
    gap: 0.45rem;
    max-width: min(22rem, calc(100% - 1.5rem));
    pointer-events: none;
  }

  .toast {
    pointer-events: auto;
    display: flex;
    align-items: flex-start;
    gap: 0.55rem;
    padding: 0.65rem 0.7rem 0.65rem 0.85rem;
    border-radius: 12px;
    border: 1px solid color-mix(in srgb, var(--idle, #f0b429) 45%, var(--border, #232833));
    background: color-mix(in srgb, var(--idle, #f0b429) 14%, var(--bg-elevated, #161a22));
    color: #f5e6b8;
    box-shadow: 0 10px 28px rgba(0, 0, 0, 0.4);
    animation: rise 0.22s ease-out;
  }

  .toast.info {
    border-color: color-mix(in srgb, var(--accent, #4c8dff) 40%, var(--border, #232833));
    background: color-mix(in srgb, var(--accent, #4c8dff) 14%, var(--bg-elevated, #161a22));
    color: #cfe0ff;
  }

  .msg {
    flex: 1;
    min-width: 0;
    font-size: 0.78rem;
    line-height: 1.4;
    word-break: break-word;
  }

  .x {
    flex-shrink: 0;
    width: 1.35rem;
    height: 1.35rem;
    border: none;
    border-radius: 6px;
    background: transparent;
    color: inherit;
    opacity: 0.7;
    cursor: pointer;
    font-size: 1rem;
    line-height: 1;
    padding: 0;
  }

  .x:hover {
    opacity: 1;
    background: color-mix(in srgb, currentColor 12%, transparent);
  }

  .mono {
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  }

  @keyframes rise {
    from {
      opacity: 0;
      transform: translateY(8px);
    }
    to {
      opacity: 1;
      transform: translateY(0);
    }
  }
</style>
