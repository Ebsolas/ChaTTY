<script lang="ts">
  import type { SessionInfo } from "$lib/types";

  interface Props {
    sessions: SessionInfo[];
    activeId: string | null;
    expandedId?: string | null;
    onOpen?: (sessionId: string) => void;
  }

  let { sessions, activeId, expandedId = null, onOpen }: Props = $props();

  function statusLabel(s: SessionInfo): string {
    if (s.activity === "tui" || s.tuiActive) return "tui";
    if (s.activity === "busy") return "busy";
    return s.status;
  }

  function statusTitle(s: SessionInfo, i: number): string {
    const key = `Alt+${i + 1}`;
    if (s.activity === "tui" || s.tuiActive) {
      return `Interactive UI (TUI) · ${s.lastCommand ?? "app"} · ${key}`;
    }
    if (s.activity === "busy" && s.lastCommand) {
      return `Running: ${s.lastCommand} · ${key}`;
    }
    return `Open terminal (${key})`;
  }
</script>

<aside class="sessions-rail">
  <div class="pane-header">
    <span>Sessions</span>
    <span class="tip">click · Ctrl+` · Alt+1</span>
  </div>
  {#if sessions.length === 0}
    <div class="empty muted">No sessions yet</div>
  {:else}
    <ul class="list">
      {#each sessions as s, i (s.id)}
        {@const label = statusLabel(s)}
        <li>
          <button
            type="button"
            class="session-row"
            class:active={s.id === activeId}
            class:expanded={s.id === expandedId}
            class:busy={s.activity === "busy"}
            class:tui={s.activity === "tui" || s.tuiActive}
            title={statusTitle(s, i)}
            onclick={() => onOpen?.(s.id)}
          >
            <span
              class="dot"
              class:running={s.status === "running" && s.activity === "idle"}
              class:busy-dot={s.activity === "busy"}
              class:tui-dot={s.activity === "tui" || s.tuiActive}
              class:exited={s.status === "exited"}
            ></span>
            <span class="meta">
              <span class="mono">@{s.name}</span>
              {#if (s.activity === "busy" || s.activity === "tui") && s.lastCommand}
                <span class="last mono">{s.lastCommand}</span>
              {/if}
            </span>
            <span class="muted sm" class:accent={label === "busy" || label === "tui"}>
              {label}
            </span>
          </button>
        </li>
      {/each}
    </ul>
  {/if}
</aside>

<style>
  .sessions-rail {
    background: var(--bg-panel);
    border-left: 1px solid var(--border);
    min-height: 0;
    display: flex;
    flex-direction: column;
  }

  .pane-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0.75rem 1rem;
    border-bottom: 1px solid var(--border);
    font-size: 0.9rem;
    color: var(--muted);
  }

  .tip {
    font-size: 0.7rem;
    opacity: 0.75;
  }

  .list {
    list-style: none;
    margin: 0;
    padding: 0.35rem 0;
  }

  .session-row {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    width: 100%;
    padding: 0.65rem 1rem;
    border: none;
    background: transparent;
    color: inherit;
    font: inherit;
    text-align: left;
    cursor: pointer;
  }

  .session-row:hover {
    background: color-mix(in srgb, var(--accent) 8%, transparent);
  }

  .session-row.active {
    background: color-mix(in srgb, var(--accent) 12%, transparent);
  }

  .session-row.expanded {
    box-shadow: inset 2px 0 0 var(--accent);
  }

  .session-row.busy {
    background: color-mix(in srgb, var(--accent) 10%, transparent);
  }

  .session-row.tui {
    background: color-mix(in srgb, #c792ea 12%, transparent);
  }

  .dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--muted);
    flex-shrink: 0;
  }

  .dot.running {
    background: var(--ok);
    box-shadow: 0 0 8px color-mix(in srgb, var(--ok) 55%, transparent);
  }

  .dot.busy-dot {
    background: var(--accent);
    box-shadow: 0 0 8px color-mix(in srgb, var(--accent) 55%, transparent);
    animation: pulse 1s ease-in-out infinite;
  }

  .dot.tui-dot {
    background: #c792ea;
    box-shadow: 0 0 8px color-mix(in srgb, #c792ea 55%, transparent);
    animation: pulse 1.2s ease-in-out infinite;
  }

  .dot.exited {
    background: #e35d6a;
  }

  @keyframes pulse {
    0%,
    100% {
      opacity: 1;
    }
    50% {
      opacity: 0.45;
    }
  }

  .meta {
    display: flex;
    flex-direction: column;
    gap: 0.1rem;
    min-width: 0;
    flex: 1;
  }

  .mono {
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    font-size: 0.85rem;
  }

  .last {
    font-size: 0.7rem;
    color: var(--muted);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .muted {
    color: var(--muted);
  }

  .sm {
    font-size: 0.78rem;
    margin-left: auto;
    text-transform: capitalize;
    flex-shrink: 0;
  }

  .sm.accent {
    color: var(--accent);
    font-weight: 600;
  }

  .session-row.tui .sm.accent {
    color: #c792ea;
  }

  .empty {
    padding: 1rem;
    font-size: 0.85rem;
  }
</style>
