<script lang="ts">
  import {
    loadComposerHistory,
    pushComposerHistory,
  } from "$lib/composerHistory";
  import { mentionSuggestions } from "$lib/mentions";
  import { chordFor, sessions, stickySessionId } from "$lib/stores";

  interface Props {
    disabled?: boolean;
    onSend: (text: string) => void | Promise<void>;
  }

  let { disabled = false, onSend }: Props = $props();
  let value = $state("");
  let sending = $state(false);
  let inputEl: HTMLInputElement | undefined = $state();

  /** Newest-first command history. */
  let history = $state<string[]>(loadComposerHistory());
  /** -1 = editing live draft; 0 = newest history entry. */
  let historyIndex = $state(-1);
  /** Snapshot of the input when history browse starts. */
  let historyDraft = $state("");

  /** Text after the @ being completed, if any. null = menu closed. */
  let mentionQuery = $state<string | null>(null);
  let mentionStart = $state(-1);
  let selectedIdx = $state(0);
  /** Escape closed the menu; stay closed until the user types or leaves the @ region. */
  let mentionDismissed = $state(false);

  const suggestions = $derived(
    mentionQuery !== null
      ? mentionSuggestions(mentionQuery, $sessions)
      : [],
  );

  const sticky = $derived($sessions.find((s) => s.id === $stickySessionId));
  const stickyName = $derived(sticky?.name ?? "local");
  const stickyIsTui = $derived(
    sticky?.activity === "tui" || !!sticky?.tuiActive,
  );

  /** Detect in-progress @mention at the caret (does not open/close the menu). */
  function mentionContextAtCaret(): { start: number; partial: string } | null {
    const el = inputEl;
    if (!el) return null;
    const pos = el.selectionStart ?? value.length;
    const before = value.slice(0, pos);
    const at = before.lastIndexOf("@");
    if (at < 0) return null;
    // @ must be start or after whitespace
    if (at > 0 && !/\s/.test(before[at - 1]!)) return null;
    const partial = before.slice(at + 1);
    // Completed mention if space after name
    if (/\s/.test(partial)) return null;
    return { start: at, partial };
  }

  function updateMentionState() {
    const ctx = mentionContextAtCaret();
    if (!ctx) {
      mentionQuery = null;
      mentionStart = -1;
      mentionDismissed = false;
      return;
    }

    // User hit Escape — keep closed while caret stays in this @ region.
    if (mentionDismissed) {
      mentionQuery = null;
      mentionStart = ctx.start;
      return;
    }

    // Only reset highlight when the filter text changes (not on ↑/↓).
    if (mentionQuery !== ctx.partial || mentionStart !== ctx.start) {
      selectedIdx = 0;
    }
    mentionQuery = ctx.partial;
    mentionStart = ctx.start;
  }

  function dismissMentionMenu() {
    mentionQuery = null;
    mentionDismissed = true;
  }

  function applyMention(name: string) {
    if (mentionStart < 0) return;
    const el = inputEl;
    const pos = el?.selectionStart ?? value.length;
    const before = value.slice(0, mentionStart);
    const after = value.slice(pos);
    value = `${before}@${name} ${after}`;
    mentionQuery = null;
    mentionStart = -1;
    mentionDismissed = false;
    // Editing live value — leave history browse mode.
    historyIndex = -1;
    requestAnimationFrame(() => {
      const caret = before.length + name.length + 2;
      inputEl?.setSelectionRange(caret, caret);
      inputEl?.focus();
    });
  }

  function historyUp() {
    if (history.length === 0) return;
    if (historyIndex === -1) {
      historyDraft = value;
      historyIndex = 0;
    } else if (historyIndex < history.length - 1) {
      historyIndex += 1;
    } else {
      return;
    }
    value = history[historyIndex] ?? "";
    mentionQuery = null;
    requestAnimationFrame(() => {
      const len = value.length;
      inputEl?.setSelectionRange(len, len);
    });
  }

  function historyDown() {
    if (historyIndex === -1) return;
    if (historyIndex <= 0) {
      historyIndex = -1;
      value = historyDraft;
    } else {
      historyIndex -= 1;
      value = history[historyIndex] ?? "";
    }
    mentionQuery = null;
    requestAnimationFrame(() => {
      const len = value.length;
      inputEl?.setSelectionRange(len, len);
    });
  }

  async function submit() {
    if (disabled || sending) return;
    const text = value;
    if (!text.trim()) return;
    sending = true;
    try {
      await onSend(text);
      history = pushComposerHistory(history, text);
      value = "";
      mentionQuery = null;
      historyIndex = -1;
      historyDraft = "";
    } finally {
      sending = false;
    }
  }

  function onKeydown(e: KeyboardEvent) {
    const menuOpen = mentionQuery !== null && suggestions.length > 0;

    if (menuOpen) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        e.stopPropagation();
        selectedIdx = (selectedIdx + 1) % suggestions.length;
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        e.stopPropagation();
        selectedIdx = (selectedIdx - 1 + suggestions.length) % suggestions.length;
        return;
      }
      if (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey)) {
        e.preventDefault();
        e.stopPropagation();
        const pick = suggestions[selectedIdx];
        if (pick) applyMention(pick.name);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        dismissMentionMenu();
        return;
      }
    }

    // Esc while dismissed but still in @… shouldn't reopen via later handlers
    if (e.key === "Escape" && mentionDismissed && mentionContextAtCaret()) {
      e.preventDefault();
      e.stopPropagation();
      return;
    }

    // Command history — not while the mention menu is open, and not while
    // dismissed-but-still-in-@ (↑ would wipe the draft with history).
    if (!menuOpen && !(mentionDismissed && mentionContextAtCaret())) {
      if (e.key === "ArrowUp") {
        e.preventDefault();
        historyUp();
        return;
      }
      if (e.key === "ArrowDown") {
        e.preventDefault();
        historyDown();
        return;
      }
    }

    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void submit();
    }
  }

  function onKeyup(e: KeyboardEvent) {
    // Don't re-sync on keys that navigate/dismiss the menu — that used to
    // reset selectedIdx to 0 and reopen after Escape.
    if (
      e.key === "ArrowUp" ||
      e.key === "ArrowDown" ||
      e.key === "Escape" ||
      e.key === "Enter" ||
      e.key === "Tab"
    ) {
      return;
    }
    updateMentionState();
  }

  function onInput() {
    // Typing re-enables the menu and abandons history browse.
    mentionDismissed = false;
    if (historyIndex !== -1) {
      historyIndex = -1;
      historyDraft = "";
    }
    updateMentionState();
  }
</script>

<div class="composer-wrap">
  {#if mentionQuery !== null && suggestions.length > 0}
    <ul class="suggest" role="listbox">
      {#each suggestions as s, i (s.id)}
        <li>
          <button
            type="button"
            class="suggest-item"
            class:active={i === selectedIdx}
            role="option"
            aria-selected={i === selectedIdx}
            onmousedown={(e) => {
              e.preventDefault();
              applyMention(s.name);
            }}
          >
            <span class="mono">@{s.name}</span>
            <span class="muted"
              >{s.activity === "tui" || s.tuiActive
                ? "tui"
                : s.activity === "busy"
                  ? "busy"
                  : s.status}</span
            >
          </button>
        </li>
      {/each}
    </ul>
  {:else if mentionQuery !== null && suggestions.length === 0}
    <div class="suggest empty-suggest">No sessions match <span class="mono">@{mentionQuery}</span></div>
  {/if}

  <form
    class="composer"
    onsubmit={(e) => {
      e.preventDefault();
      void submit();
    }}
  >
    <input
      class="composer-input"
      data-composer-input
      type="text"
      placeholder={stickyIsTui
        ? `@${stickyName} is in TUI — @another session to keep working`
        : `Command or @session …  (sticky: @${stickyName}) · ↑ history`}
      bind:value
      bind:this={inputEl}
      {disabled}
      onkeydown={onKeydown}
      oninput={onInput}
      onclick={updateMentionState}
      onkeyup={onKeyup}
      autocomplete="off"
      spellcheck="false"
    />
    <button
      class="send"
      type="submit"
      disabled={disabled || sending || !value.trim()}
    >
      Send →
    </button>
  </form>
  <p class="hint">
    {#if stickyIsTui}
      @{stickyName} is in TUI — no line inject · <kbd>Ctrl+C</kbd> interrupts sticky · <kbd>@other</kbd>+<kbd>Ctrl+C</kbd> for another
    {:else}
      sticky @{stickyName} · <kbd>@name</kbd>+<kbd>Ctrl+C</kbd> interrupt that session · ↑/↓ history · {chordFor("toggleTerminal")}
    {/if}
  </p>
</div>

<style>
  .composer-wrap {
    position: relative;
    background: var(--bg-panel, #12151c);
    color: var(--text, #e8eaed);
    border-top: 1px solid var(--border, #232833);
  }

  .suggest {
    position: absolute;
    left: 1rem;
    right: 5.5rem;
    bottom: 100%;
    margin: 0 0 0.25rem;
    padding: 0.35rem 0;
    list-style: none;
    background: var(--bg-elevated, #161a22);
    border: 1px solid var(--border, #232833);
    border-radius: 10px;
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.35);
    max-height: 12rem;
    overflow-y: auto;
    z-index: 30;
  }

  .empty-suggest {
    padding: 0.55rem 0.85rem;
    font-size: 0.8rem;
    color: var(--muted, #8b93a7);
  }

  .suggest-item {
    display: flex;
    width: 100%;
    align-items: center;
    justify-content: space-between;
    gap: 0.75rem;
    border: none;
    background: transparent;
    color: inherit;
    font: inherit;
    padding: 0.45rem 0.85rem;
    cursor: pointer;
    text-align: left;
  }

  .suggest-item:hover,
  .suggest-item.active {
    background: color-mix(in srgb, var(--accent, #4c8dff) 18%, transparent);
  }

  .mono {
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    font-size: 0.85rem;
  }

  .muted {
    color: var(--muted, #8b93a7);
    font-size: 0.75rem;
    text-transform: capitalize;
  }

  .composer {
    display: flex;
    gap: 0.75rem;
    padding: 0.85rem 1rem 0.35rem;
  }

  .composer-input {
    flex: 1;
    border-radius: 999px;
    border: 1px solid var(--border);
    background: var(--bg-elevated);
    color: var(--text);
    padding: 0.7rem 1rem;
    font: inherit;
    outline: none;
  }

  .composer-input:focus {
    border-color: color-mix(in srgb, var(--accent) 60%, var(--border));
  }

  .composer-input:disabled,
  .send:disabled {
    opacity: 0.55;
    cursor: not-allowed;
  }

  .send {
    border: none;
    border-radius: 999px;
    background: var(--accent);
    color: white;
    font: inherit;
    font-weight: 600;
    padding: 0.7rem 1.1rem;
    cursor: pointer;
  }

  .send:hover:not(:disabled) {
    filter: brightness(1.08);
  }

  .hint {
    margin: 0;
    padding: 0 1rem 0.65rem;
    font-size: 0.72rem;
    color: var(--muted, #8b93a7);
  }

  .hint kbd {
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    font-size: 0.9em;
    padding: 0.05em 0.3em;
    border-radius: 4px;
    border: 1px solid var(--border, #232833);
  }
</style>
