<script module lang="ts">
  /** A numbered note pinned on the preview; x and y are percentages of the preview box. */
  export type Pin = { n: number; x: number; y: number; text: string; sent: boolean };
</script>

<script lang="ts">
  /**
   * The annotation layer over a preview: a transparent surface that turns a click (or Enter, for the
   * keyboard) into a pin, and the pins with their note boxes. It sits over iframes too, which would
   * otherwise swallow the click; video and audio leave a strip at the bottom for their controls.
   */
  let {
    pins,
    userMode,
    hasControls,
    label,
    placeholder,
    sendLabel,
    onplace,
    ontext,
    onsend
  }: {
    pins: Pin[];
    userMode: boolean;
    hasControls: boolean;
    label: string;
    placeholder: string;
    sendLabel: string;
    onplace: (x: number, y: number) => void;
    ontext: (n: number, text: string) => void;
    onsend: (pin: Pin) => void;
  } = $props();

  function onclick(e: MouseEvent) {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    onplace(((e.clientX - r.left) / r.width) * 100, ((e.clientY - r.top) / r.height) * 100);
  }

  function onkeydown(e: KeyboardEvent) {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      onplace(50, 45);
    }
  }
</script>

<div class="clicks" class:has-controls={hasControls} role="button" tabindex="0" aria-label={label} {onclick} {onkeydown}></div>
{#each pins as pin (pin.n)}
  <div class="pin" style:left="{pin.x}%" style:top="{pin.y}%">
    <span class="dot" title={pin.text}>{pin.n}</span>
    {#if !pin.sent || !userMode}
      <div class="pop" class:to-left={pin.x > 55} class:to-up={pin.y > 55}>
        {#if userMode}
          <textarea
            rows="2"
            {placeholder}
            aria-label={placeholder}
            value={pin.text}
            oninput={(e) => ontext(pin.n, e.currentTarget.value)}
          ></textarea>
          <button type="button" class="send" onclick={() => onsend(pin)}>{sendLabel}</button>
        {:else}
          <span class="note">{pin.text}</span>
        {/if}
      </div>
    {/if}
  </div>
{/each}

<style>
  /* Catches the clicks that place a pin, over iframes too; media keep a strip for their controls. */
  .clicks {
    position: absolute;
    inset: 0;
    cursor: crosshair;
  }

  .clicks.has-controls {
    bottom: 56px;
  }

  .pin {
    position: absolute;
    width: 0;
    height: 0;
    z-index: 2;
  }

  .dot {
    position: absolute;
    left: -10px;
    top: -10px;
    width: 20px;
    height: 20px;
    border-radius: 50%;
    background: var(--teal);
    color: var(--on-teal);
    font: 600 11px/20px var(--font-mono);
    text-align: center;
    box-shadow: 0 0 0 3px var(--paper), var(--shadow-float);
    animation: drop 0.32s cubic-bezier(0.3, 1.5, 0.5, 1) both;
  }

  @keyframes drop {
    from {
      opacity: 0;
      transform: translateY(-14px) scale(0.6);
    }
  }

  .pop {
    position: absolute;
    left: 16px;
    top: 12px;
    width: 170px;
    padding: 7px;
    display: flex;
    flex-direction: column;
    gap: 6px;
    background: var(--paper);
    border: 1px solid var(--teal-line);
    border-radius: var(--radius-md);
    box-shadow: var(--shadow-float);
  }

  .pop.to-left {
    left: auto;
    right: 16px;
  }

  .pop.to-up {
    top: auto;
    bottom: 12px;
  }

  .note {
    font-size: 12px;
    color: var(--ink);
    line-height: 1.4;
  }

  textarea {
    resize: none;
    width: 100%;
    box-sizing: border-box;
    font: inherit;
    font-size: 12px;
    padding: 5px 7px;
    color: var(--ink);
    background: var(--paper);
    border: 1px solid var(--line);
    border-radius: var(--radius-sm);
  }

  textarea:focus-visible {
    outline: 2px solid var(--teal);
    outline-offset: -1px;
  }

  .send {
    align-self: flex-end;
    border: 0;
    border-radius: var(--radius-sm);
    padding: 4px 10px;
    font: inherit;
    font-size: 12px;
    background: var(--teal);
    color: var(--on-teal);
    cursor: pointer;
  }

  .send:hover {
    background: var(--teal-2);
  }

  .clicks:focus-visible,
  .send:focus-visible {
    outline: 2px solid var(--teal);
    outline-offset: 1px;
  }

  @media (prefers-reduced-motion: reduce) {
    .dot {
      animation: none;
    }
  }
</style>
