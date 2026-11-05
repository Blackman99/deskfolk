<script lang="ts">
  import { base } from '$app/paths';
  import type { SceneCopy } from '../../copy';
  import { AGENT_IDS, ALL_IDS, ENDPOINT_IDS, type SocketId } from './beats';

  /**
   * The socket board: two labelled groups of sockets, one radiogroup, and the Custom socket's
   * address form. It only shows state and reports what was picked; the plug is the scene's. Each
   * socket wears its brand's mark, the very one the app draws (static/logos, written by
   * scripts/logos/build.py from the messenger's logo components); Custom is nobody's brand, so it
   * gets a plain link glyph in the page's own ink.
   */
  let {
    copy,
    names,
    connectedText,
    plugId,
    connected,
    host,
    formOpen,
    url = $bindable(),
    kind = $bindable(),
    error,
    onpick,
    onsubmit
  }: {
    copy: SceneCopy['models'];
    names: Record<string, string>;
    connectedText: string;
    plugId: SocketId | null;
    connected: SocketId | null;
    host: string;
    formOpen: boolean;
    url: string;
    kind: 0 | 1;
    error: string;
    onpick: (id: SocketId) => void;
    onsubmit: () => void;
  } = $props();

  let group: HTMLElement | undefined = $state();
  let input: HTMLInputElement | undefined = $state();

  export function focusInput() {
    input?.focus();
  }

  const label = (id: SocketId) => (id === 'custom' ? copy.custom : names[id]);
  // One tab stop: the plugged socket, else the first.
  const stop = $derived(plugId ?? ALL_IDS[0]);

  /** Arrow keys move between sockets; Enter or Space plugs in, as a click does. */
  function keys(e: KeyboardEvent, id: SocketId) {
    const at = ALL_IDS.indexOf(id);
    let to = -1;
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') to = (at + 1) % ALL_IDS.length;
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') to = (at + ALL_IDS.length - 1) % ALL_IDS.length;
    else if (e.key === 'Home') to = 0;
    else if (e.key === 'End') to = ALL_IDS.length - 1;
    if (to < 0) return;
    e.preventDefault();
    group?.querySelector<HTMLElement>(`[data-id="${ALL_IDS[to]}"]`)?.focus();
  }
</script>

{#snippet socket(id: SocketId)}
  <button
    type="button"
    role="radio"
    class="socket"
    class:is-on={connected === id}
    class:is-here={plugId === id}
    aria-checked={plugId === id}
    tabindex={stop === id ? 0 : -1}
    data-id={id}
    onclick={() => onpick(id)}
    onkeydown={(e) => keys(e, id)}
  >
    <span class="hole" data-hole={id} aria-hidden="true"></span>
    <span class="mark" class:is-custom={id === 'custom'} aria-hidden="true">
      {#if id === 'custom'}
        <svg viewBox="0 0 24 24"><path d="M10 14a4.5 4.5 0 0 0 6.4 0l3-3a4.5 4.5 0 0 0-6.4-6.4l-1.2 1.2" /><path d="M14 10a4.5 4.5 0 0 0-6.4 0l-3 3a4.5 4.5 0 0 0 6.4 6.4l1.2-1.2" /></svg>
      {:else}
        <img src="{base}/logos/{id}.svg" alt="" width="24" height="24" decoding="async" draggable="false" />
      {/if}
    </span>
    <span class="name">{label(id)}</span>
    <span class="state" class:mono={id === 'custom' && connected === id}>
      {#if connected === id}{id === 'custom' && host ? host : connectedText}{/if}
    </span>
  </button>
{/snippet}

<div
  class="board"
  role="radiogroup"
  aria-label="{copy.agents} / {copy.endpoints}"
  bind:this={group}
>
  <div class="grp" role="presentation">
    <p class="title">{copy.agents}</p>
    <div class="tiles" role="presentation">
      {#each AGENT_IDS as id}{@render socket(id)}{/each}
    </div>
  </div>
  <div class="grp" role="presentation">
    <p class="title">{copy.endpoints}</p>
    <div class="tiles" role="presentation">
      {#each ENDPOINT_IDS as id}{@render socket(id)}{/each}
      {@render socket('custom')}
    </div>
  </div>
</div>

{#if formOpen}
  <form
    class="form"
    onsubmit={(e) => {
      e.preventDefault();
      onsubmit();
    }}
  >
    <label class="field">
      <span>{copy.customLabel}</span>
      <input
        bind:this={input}
        class="mono"
        type="text"
        inputmode="url"
        autocomplete="off"
        spellcheck="false"
        placeholder={copy.customPlaceholder}
        bind:value={url}
        aria-invalid={error ? true : undefined}
      />
    </label>
    <div class="row">
      <div class="kinds" role="radiogroup" aria-label={copy.customLabel}>
        {#each copy.customKinds as k, i}
          <button type="button" role="radio" class="chip" aria-checked={kind === i} onclick={() => (kind = i as 0 | 1)}>
            {k}
          </button>
        {/each}
      </div>
      <button type="submit" class="go">{copy.connect}</button>
    </div>
    {#if error}<p class="error" role="alert">{error}</p>{/if}
  </form>
{/if}

<style>
  .board {
    display: grid;
    grid-template-columns: 1fr;
    gap: 14px;
    padding: 12px;
    border: 1px solid var(--line);
    border-radius: var(--radius-lg);
    background: var(--ground-2);
  }

  .title {
    margin: 0 0 7px;
    font-size: 11.5px;
    font-weight: 600;
    letter-spacing: 0.04em;
    color: var(--ink-3);
  }

  .tiles {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 6px;
  }

  .socket {
    position: relative;
    display: grid;
    grid-template-columns: auto 1fr;
    grid-template-rows: auto auto;
    column-gap: 4px;
    align-items: center;
    min-width: 0;
    height: 38px;
    padding: 0 5px;
    -webkit-user-select: none;
    user-select: none;
    text-align: left;
    font: inherit;
    color: var(--ink);
    background: var(--paper);
    border: 1px solid var(--line);
    border-radius: var(--radius-md);
    box-shadow: 0 1px 0 var(--line-2);
    cursor: pointer;
    transition:
      background-color 0.2s,
      border-color 0.2s,
      box-shadow 0.2s;
  }

  .socket:hover {
    border-color: var(--ink-3);
  }

  .socket:focus-visible {
    outline: 2px solid var(--teal);
    outline-offset: 2px;
  }

  .socket.is-on {
    background: var(--teal-tint);
    border-color: var(--teal-line);
    box-shadow:
      0 0 0 3px var(--teal-tint),
      0 0 18px -4px var(--teal);
  }

  /* Narrow, the socket is a small port in the tile's bottom-right corner, under the name's line
     and beside the short state line, leaving the width to the name; wide, it sits in front of the
     mark (below). */
  .hole {
    position: absolute;
    bottom: 6px;
    right: 6px;
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: var(--ground-2);
    box-shadow:
      inset 0 2px 3px rgba(0, 0, 0, 0.28),
      0 0 0 2px var(--line);
    transition: background-color 0.2s;
  }

  .is-on .hole {
    background: var(--teal);
    box-shadow:
      inset 0 1px 2px rgba(0, 0, 0, 0.25),
      0 0 0 2px var(--teal-line);
  }

  /* The brand's mark, on its own tile in both themes, as in the app. */
  .mark {
    grid-row: 1 / 3;
    display: block;
    width: 16px;
    height: 16px;
    border-radius: 4px;
    overflow: hidden;
    box-shadow: 0 0 0 1px rgba(0, 0, 0, 0.08);
  }

  .mark img {
    display: block;
    width: 100%;
    height: 100%;
    pointer-events: none;
    -webkit-user-drag: none;
  }

  .mark.is-custom {
    padding: 3px;
    box-sizing: border-box;
    background: var(--ground-2);
    box-shadow: 0 0 0 1px var(--line);
  }

  .mark.is-custom svg {
    display: block;
    width: 100%;
    height: 100%;
    fill: none;
    stroke: var(--ink-2);
    stroke-width: 2.2;
    stroke-linecap: round;
  }

  .name {
    align-self: end;
    min-width: 0;
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
    font-size: 11.5px;
    font-weight: 560;
    letter-spacing: -0.01em;
    line-height: 1.25;
  }

  .state {
    align-self: start;
    padding-right: 10px;
    min-height: 13px;
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
    font-size: 10.5px;
    line-height: 13px;
    color: var(--teal);
  }

  .mono,
  input {
    font-family: var(--font-mono);
  }

  .form {
    display: grid;
    gap: 8px;
    margin-top: 10px;
    padding: 10px 12px;
    border: 1px solid var(--teal-line);
    border-radius: var(--radius-md);
    background: var(--paper);
  }

  .field {
    display: grid;
    gap: 5px;
    font-size: 11.5px;
    color: var(--ink-3);
  }

  input {
    width: 100%;
    box-sizing: border-box;
    height: 34px;
    padding: 0 10px;
    font-size: 12.5px;
    color: var(--ink);
    background: var(--ground);
    border: 1px solid var(--line);
    border-radius: var(--radius-sm);
  }

  input:focus-visible {
    outline: 2px solid var(--teal);
    outline-offset: 1px;
  }

  input[aria-invalid='true'] {
    border-color: var(--ink-2);
  }

  .row {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
  }

  .kinds {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }

  .chip {
    height: 28px;
    padding: 0 10px;
    font: inherit;
    font-size: 12px;
    color: var(--ink-2);
    background: transparent;
    border: 1px solid var(--line);
    border-radius: var(--radius-full);
    cursor: pointer;
    transition:
      background-color 0.15s,
      border-color 0.15s,
      color 0.15s;
  }

  .chip[aria-checked='true'] {
    color: var(--teal);
    background: var(--teal-tint);
    border-color: var(--teal-line);
  }

  .chip:focus-visible,
  .go:focus-visible {
    outline: 2px solid var(--teal);
    outline-offset: 2px;
  }

  .go {
    height: 30px;
    padding: 0 16px;
    font: inherit;
    font-size: 12.5px;
    font-weight: 600;
    color: var(--on-teal);
    background: var(--teal);
    border: 0;
    border-radius: var(--radius-sm);
    cursor: pointer;
  }

  .go:hover {
    background: var(--teal-2);
  }

  .error {
    margin: 0;
    font-size: 12px;
    color: var(--ink-2);
  }

  @container (min-width: 520px) {
    .board {
      grid-template-columns: 1fr 1fr;
      gap: 16px;
      padding: 16px;
    }

    .tiles {
      grid-template-columns: 1fr 1fr;
    }

    .socket {
      grid-template-columns: auto auto 1fr;
      height: 48px;
      padding: 0 8px;
      column-gap: 7px;
    }

    .state {
      padding-right: 0;
    }

    .hole {
      position: static;
      grid-row: 1 / 3;
      width: 12px;
      height: 12px;
    }

    .mark {
      width: 22px;
      height: 22px;
      border-radius: 5px;
    }

    .mark.is-custom {
      padding: 4px;
    }

    .tiles {
      gap: 8px;
    }

    .name {
      font-size: 13.5px;
      letter-spacing: 0;
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .socket,
    .hole,
    .chip {
      transition: none;
    }
  }
</style>
