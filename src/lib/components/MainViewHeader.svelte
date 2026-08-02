<script lang="ts">
  import { chromeLayout, toggleLeftRails, toggleSessionsRail } from "$lib/chromeLayout";
  import { chordFor } from "$lib/stores";

  interface Props {
    title: string;
    subtitle?: string;
  }

  let { title, subtitle = "" }: Props = $props();
</script>

<header class="main-view-header">
  <div class="side left">
    <button
      type="button"
      class="rail-btn"
      title={$chromeLayout.leftRailsVisible
        ? `Hide left rails (${chordFor("toggleLeftRails")})`
        : `Show left rails (${chordFor("toggleLeftRails")})`}
      aria-pressed={!$chromeLayout.leftRailsVisible}
      onclick={() => toggleLeftRails()}
    >
      {#if $chromeLayout.leftRailsVisible}
        <span class="icon" aria-hidden="true">«</span>
        <span class="label">Hide rails</span>
      {:else}
        <span class="icon" aria-hidden="true">»</span>
        <span class="label">Show rails</span>
      {/if}
    </button>
  </div>

  <div class="center" title={subtitle ? `${title} ${subtitle}` : title}>
    <span class="title">{title}</span>
    {#if subtitle}
      <span class="subtitle">{subtitle}</span>
    {/if}
  </div>

  <div class="side right">
    <button
      type="button"
      class="rail-btn"
      title={$chromeLayout.sessionsRailVisible
        ? `Hide sessions rail (${chordFor("toggleSessionsRail")})`
        : `Show sessions rail (${chordFor("toggleSessionsRail")})`}
      aria-pressed={!$chromeLayout.sessionsRailVisible}
      onclick={() => toggleSessionsRail()}
    >
      {#if $chromeLayout.sessionsRailVisible}
        <span class="label">Hide sessions</span>
        <span class="icon" aria-hidden="true">»</span>
      {:else}
        <span class="label">Show sessions</span>
        <span class="icon" aria-hidden="true">«</span>
      {/if}
    </button>
  </div>
</header>

<style>
  .main-view-header {
    flex: 0 0 auto;
    display: grid;
    grid-template-columns: minmax(6.5rem, 1fr) minmax(0, 2.2fr) minmax(6.5rem, 1fr);
    align-items: center;
    gap: 0.5rem;
    min-height: 2.35rem;
    padding: 0.3rem 0.45rem;
    border-bottom: 1px solid var(--border, #232833);
    background: var(--bg-panel, #12151c);
    z-index: 2;
  }

  .side {
    display: flex;
    align-items: center;
    min-width: 0;
  }

  .side.left {
    justify-content: flex-start;
  }

  .side.right {
    justify-content: flex-end;
  }

  .center {
    min-width: 0;
    text-align: center;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .title {
    font-weight: 600;
    font-size: 0.92rem;
    color: var(--text, #e8eaed);
  }

  .subtitle {
    font-weight: 400;
    font-size: 0.85rem;
    color: var(--muted, #8b93a7);
    margin-left: 0.35rem;
  }

  .rail-btn {
    display: inline-flex;
    align-items: center;
    gap: 0.3rem;
    border: 1px solid var(--border, #232833);
    border-radius: 7px;
    background: var(--bg-elevated, #161a22);
    color: var(--text, #e8eaed);
    font: inherit;
    font-size: 0.75rem;
    padding: 0.28rem 0.5rem;
    cursor: pointer;
    max-width: 100%;
  }

  .rail-btn:hover {
    border-color: var(--accent, #4c8dff);
    color: var(--accent, #4c8dff);
  }

  .rail-btn[aria-pressed="true"] {
    border-color: color-mix(in srgb, var(--accent, #4c8dff) 50%, var(--border, #232833));
    background: color-mix(in srgb, var(--accent, #4c8dff) 12%, var(--bg-elevated, #161a22));
  }

  .icon {
    font-size: 0.85rem;
    line-height: 1;
    opacity: 0.9;
  }

  .label {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  @media (max-width: 900px) {
    .rail-btn .label {
      display: none;
    }
    .rail-btn {
      padding: 0.28rem 0.45rem;
    }
  }
</style>
