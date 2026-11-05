<script lang="ts">
  import { clamp } from '../motion';
  import type { SceneProps } from '../scene';
  import { useStage } from '../stage.svelte';
  import Stand from '../Stand.svelte';
  import { CAP, SAMPLE_ROWS, capCrossIndex } from '../ledger';
  import MiniChat from './spend/MiniChat.svelte';
  import Receipt from './spend/Receipt.svelte';

  /**
   * The ledger and the daily cap. A receipt prints a row for every model call (reported and
   * estimated cost apart), each row pointing back at the message that set it off; when the day's
   * spend reaches the cap a stamp lands and Pudding stops until you press Lift.
   *
   * Beats by `p`: 0.08 to 0.72 the receipt prints (the header, each row, the totals); 0.78 the
   * stamp. Any click puts the scene in user mode: the stamp and the selected row then stay as the
   * reader left them until the chapter is left.
   */
  let { copy, p, active }: SceneProps<'spend'> = $props();
  const stage = useStage();

  const rows = SAMPLE_ROWS;
  const N = rows.length;
  const capIndex = capCrossIndex(rows, CAP);
  const capLabel = $derived(copy.cap(`$${CAP.toFixed(2)}`));

  const PRINT_FROM = 0.08;
  const PRINT_TO = 0.72;
  const STAMP_AT = 0.78;

  // How far each piece of the receipt has come out: the header, the rows, then the totals.
  const u = $derived(clamp((p - PRINT_FROM) / (PRINT_TO - PRINT_FROM)) * (N + 2));
  const head = $derived(clamp(u));
  const fills = $derived(rows.map((_, i) => clamp(u - 1 - i)));
  const foot = $derived(clamp(u - 1 - N));

  // The newest row on the paper; while it prints, the message behind it is the one pointed out.
  const lastPrinted = $derived(fills.reduce((n, f, i) => (f > 0.15 ? i : n), -1));
  const autoStamp = $derived(p >= STAMP_AT);
  const autoSel = $derived(stage.reduced || p <= PRINT_FROM ? -1 : lastPrinted);

  // User mode: set by the first click, ended when the reader leaves the chapter.
  let user = $state(false);
  let userStamp = $state(false);
  let userSel = $state(-1);
  let released = $state(false);
  let celebrate = $state(false);
  let celebrateTimer: ReturnType<typeof setTimeout> | undefined;

  const stamp = $derived(user ? userStamp : autoStamp);
  const sel = $derived(user ? userSel : autoSel);
  const selMsg = $derived(sel >= 0 ? rows[sel].message : -1);

  function enterUser() {
    if (user) return;
    userStamp = autoStamp;
    userSel = autoSel;
    user = true;
  }

  function pick(i: number) {
    enterUser();
    userSel = i;
  }

  function release() {
    enterUser();
    userStamp = true;
    released = true;
    celebrate = true;
    clearTimeout(celebrateTimer);
    celebrateTimer = setTimeout(() => (celebrate = false), stage.reduced ? 0 : 1500);
  }

  $effect(() => {
    if (active) return;
    user = false;
    userSel = -1;
    released = false;
    celebrate = false;
    clearTimeout(celebrateTimer);
  });

  // Which messages have been sent: the first row a message set off has come out.
  const shown = $derived(copy.messages.map((_, m) => fills[rows.findIndex((r) => r.message === m)] > 0));
  const targets = $derived(copy.messages.map((_, m) => rows.find((r) => r.message === m)?.bot ?? 'producer'));

  $effect(() => {
    if (!active) return;
    const printing = p > PRINT_FROM && !stamp;
    if (stamp && released) {
      stage.act('pudding', { pose: celebrate ? 'cheer' : 'work', say: null, held: null, away: false, mirror: true });
      stage.act('mochi', { pose: 'idle', say: null, held: null, away: false, mirror: false });
    } else if (stamp) {
      stage.act('pudding', { pose: 'rest', say: copy.stopped, held: null, away: false, mirror: true });
      stage.act('mochi', { pose: 'point', say: null, held: null, away: false, mirror: false });
    } else {
      stage.act('pudding', { pose: printing ? 'work' : 'idle', say: null, held: printing ? 'receipt' : null, away: false, mirror: true });
      stage.act('mochi', { pose: printing ? 'look' : 'idle', say: null, held: null, away: false, mirror: false });
    }
  });

  // A thin teal line from the pointed-at row to its message, drawn when the two sit side by side.
  let root: HTMLElement | undefined = $state();
  let link = $state.raw<{ d: string; sx: number; sy: number } | null>(null);

  function measure() {
    if (!root || sel < 0) return null;
    const rowEl = root.querySelector<HTMLElement>(`[data-row="${sel}"]`);
    const msgEl = root.querySelector<HTMLElement>(`[data-msg="${selMsg}"]`);
    const chatEl = root.querySelector<HTMLElement>('[data-chat]');
    if (!rowEl || !msgEl || !chatEl) return null;
    const r = root.getBoundingClientRect();
    const a = rowEl.getBoundingClientRect();
    const b = msgEl.getBoundingClientRect();
    const c = chatEl.getBoundingClientRect();
    const my = b.top + b.height / 2;
    if (b.right > a.left - 12 || my < c.top || my > c.bottom || a.height < 8) return null;
    const sx = a.left - r.left;
    const sy = a.top + a.height / 2 - r.top;
    const ex = b.right - r.left;
    const ey = my - r.top;
    const k = (sx - ex) / 2;
    return { d: `M${ex} ${ey} C${ex + k} ${ey} ${sx - k} ${sy} ${sx} ${sy}`, sx, sy };
  }

  $effect(() => {
    void sel;
    if (!active || sel < 0) {
      link = null;
      return;
    }
    if (stage.reduced) {
      const again = () => (link = measure());
      const t = setTimeout(again, 0);
      addEventListener('resize', again);
      return () => {
        clearTimeout(t);
        removeEventListener('resize', again);
      };
    }
    let raf = 0;
    const loop = () => {
      raf = requestAnimationFrame(loop);
      const next = measure();
      if (next?.d !== link?.d) link = next;
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  });
</script>

<div class="spend" bind:this={root}>
  <div class="chat"><MiniChat {copy} {shown} {targets} selected={selMsg} /></div>
  <div class="paper">
    <Receipt
      {copy}
      {rows}
      {capIndex}
      {capLabel}
      {head}
      {fills}
      {foot}
      {stamp}
      {released}
      selected={sel}
      onpick={pick}
      onrelease={release}
    />
  </div>
  <div class="mochi"><Stand who="mochi" size={stage.wide ? 100 : 84} /></div>
  <div class="pudding"><Stand who="pudding" size={stage.wide ? 100 : 84} /></div>

  {#if link}
    <svg class="link" aria-hidden="true">
      <path d={link.d} />
      <circle cx={link.sx} cy={link.sy} r="3" />
    </svg>
  {/if}
</div>

<style>
  .spend {
    position: relative;
    display: grid;
    grid-template-columns: minmax(0, 1fr) minmax(0, 330px);
    grid-template-rows: minmax(0, 1fr) auto;
    grid-template-areas:
      'chat paper'
      'mochi pudding';
    column-gap: 22px;
    row-gap: 54px;
    height: 100%;
    align-content: start;
  }

  /* English Bot names and tags are longer: a wider receipt beside the chat. */
  @container (min-width: 561px) {
    .spend:lang(en) {
      grid-template-columns: minmax(0, 1fr) minmax(0, 390px);
    }
  }

  .chat {
    grid-area: chat;
    display: flex;
    flex-direction: column;
    justify-content: flex-start;
    min-height: 0;
    padding-top: 22px;
  }

  .paper {
    grid-area: paper;
    align-self: start;
  }

  .mochi {
    grid-area: mochi;
    justify-self: end;
  }

  .pudding {
    grid-area: pudding;
    justify-self: center;
  }

  .link {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    overflow: visible;
    pointer-events: none;
    z-index: 4;
  }

  .link path {
    fill: none;
    stroke: var(--teal);
    stroke-width: 1.25;
    opacity: 0.8;
  }

  .link circle {
    fill: var(--teal);
  }

  /* Narrow: Mochi, the chat and Pudding in one band, the receipt below. */
  @container (max-width: 560px) {
    .spend {
      grid-template-columns: 84px minmax(0, 1fr) 84px;
      grid-template-rows: auto auto;
      grid-template-areas:
        'mochi chat pudding'
        'paper paper paper';
      column-gap: 6px;
      row-gap: 10px;
      padding-top: 46px;
      height: auto;
    }

    .chat {
      max-height: 132px;
      padding-top: 0;
      align-self: end;
    }

    .mochi,
    .pudding {
      align-self: end;
      justify-self: center;
    }

    .paper {
      justify-self: center;
      width: 100%;
      max-width: 340px;
    }
  }
</style>
