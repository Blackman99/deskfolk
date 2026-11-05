<script lang="ts">
  import { span } from '../../motion';
  import type { SceneCopy } from '../../copy';
  import { formatTokens, totals, type LedgerRow } from '../../ledger';

  /**
   * The thermal receipt: a dark printer mouth with a paper strip coming out of it, one ledger row at
   * a time, a zigzag tear at the bottom. Reported and estimated amounts are told apart and totalled
   * separately. Every row is a button that points at the message that set the call off. The daily
   * cap is a dashed line across the paper, at the call that crossed it, and the stamp lands there.
   */
  let {
    copy,
    rows,
    capIndex,
    capLabel,
    head,
    fills,
    foot,
    stamp,
    released,
    selected,
    onpick,
    onrelease
  }: {
    copy: SceneCopy['spend'];
    rows: readonly LedgerRow[];
    capIndex: number;
    capLabel: string;
    /** How much of the header, of each row and of the totals has come out of the printer, 0 to 1. */
    head: number;
    fills: number[];
    foot: number;
    stamp: boolean;
    released: boolean;
    /** The row pointed at, or -1. */
    selected: number;
    onpick: (index: number) => void;
    onrelease: () => void;
  } = $props();

  const sums = $derived(totals(rows));
  const usd = (n: number) => `$${n.toFixed(2)}`;
  const bit = (f: number) => span(f, 0, 1);
</script>

<div class="receipt">
  <div class="mouth" aria-hidden="true"></div>
  <div class="strip">
    <div class="paper">
      <div class="part" style:--f={bit(head)} inert={head <= 0}>
        <div class="title">
          <strong>{copy.title}</strong>
          <span class="badge">{copy.sample}</span>
        </div>
        <div class="cols" aria-hidden="true">
          <span>{copy.columns[0]}</span><span>{copy.columns[1]}</span><span>{copy.columns[2]}</span>
          <span class="r">{copy.columns[3]}</span><span class="r">{copy.columns[4]}</span><span></span>
        </div>
      </div>

      {#each rows as row, i (i)}
        {#if fills[i] > 0}
          {#if i === capIndex}
            <div class="cap" style:--f={bit(fills[i])} class:hit={stamp}>
              <span>{capLabel}</span>
            </div>
          {/if}
          <div class="part" style:--f={bit(fills[i])}>
            <button
              type="button"
              class="row"
              class:sel={selected === i}
              class:over={capIndex >= 0 && i >= capIndex}
              data-row={i}
              aria-label="{copy.jump} ({row.time})"
              onclick={() => onpick(i)}
            >
              <span class="t">{row.time}</span>
              <span>{copy.bots[row.bot]}</span>
              <span class="m">{row.model}</span>
              <span class="r">{formatTokens(row.tokensIn + row.tokensOut)}</span>
              <span class="r amt" class:est={row.kind === 'estimated'}>{usd(row.usd)}</span>
              <span class="tag" class:est={row.kind === 'estimated'}>{row.kind === 'reported' ? copy.reported : copy.estimated}</span>
            </button>
          </div>
        {/if}
      {/each}

      <div class="part totals" style:--f={bit(foot)} inert={foot <= 0}>
        <div class="sum">
          <span>{copy.totalReported}</span><b>{usd(sums.reported)}</b>
        </div>
        <div class="sum est">
          <span>{copy.totalEstimated}</span><b class="amt est">{usd(sums.estimated)}</b>
        </div>
        <div class="tail"></div>
      </div>
    </div>

    {#if stamp}
      <div class="stamp" class:released role="status">{released ? copy.released : copy.capHit}</div>
    {/if}
  </div>

  <div class="release">
    {#if stamp && !released}
      <button type="button" class="lift" onclick={onrelease}>{copy.release}</button>
    {/if}
  </div>
</div>

<style>
  .receipt {
    position: relative;
    width: 100%;
    font-family: var(--font-mono);
    font-size: 10.5px;
    color: var(--ink);
  }

  /* The printer's mouth: a dark slot the paper comes out from under. */
  .mouth {
    position: relative;
    z-index: 2;
    height: 14px;
    margin: 0 -6px;
    border-radius: 7px;
    background: linear-gradient(#2a363b, #141c20);
    box-shadow: 0 3px 8px -2px rgba(0, 0, 0, 0.35);
  }

  .mouth::after {
    content: '';
    position: absolute;
    left: 8px;
    right: 8px;
    bottom: 3px;
    height: 2px;
    border-radius: 1px;
    background: #05090a;
  }

  .strip {
    position: relative;
    margin: -3px 6px 0;
    /* A shadow that follows the zigzag, which a plain box-shadow would not. */
    filter: drop-shadow(0 1px 0 var(--line)) drop-shadow(0 8px 10px rgba(18, 28, 32, 0.14));
  }

  .paper {
    padding: 8px 12px 14px;
    background: var(--paper);
    -webkit-mask:
      linear-gradient(#000, #000) top / 100% calc(100% - 7px) no-repeat,
      conic-gradient(from -45deg at bottom, #0000, #000 1deg 89deg, #0000 90deg) bottom / 14px 7px repeat-x;
    mask:
      linear-gradient(#000, #000) top / 100% calc(100% - 7px) no-repeat,
      conic-gradient(from -45deg at bottom, #0000, #000 1deg 89deg, #0000 90deg) bottom / 14px 7px repeat-x;
  }

  /* Under the mouth the paper is in shadow. */
  .paper::before {
    content: '';
    position: absolute;
    left: 0;
    right: 0;
    top: 0;
    height: 10px;
    background: linear-gradient(rgba(18, 28, 32, 0.16), transparent);
    pointer-events: none;
  }

  /* Each piece slides out of the slot: its height grows while its content comes down from above. */
  .part {
    --h: 26px;
    height: calc(var(--h) * var(--f));
    overflow: hidden;
  }

  .part > :global(*) {
    transform: translateY(calc((1 - var(--f)) * -100%));
  }

  .part:first-child {
    --h: 52px;
  }

  .totals {
    --h: 70px;
  }

  .title {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    height: 30px;
    font-size: 11.5px;
  }

  .badge {
    padding: 1px 6px;
    border: 1px dashed var(--ink-3);
    border-radius: var(--radius-full);
    color: var(--ink-3);
    font-size: 9px;
  }

  /* Columns in ch of the receipt's own type, so the header and every row line up; English Bot
     names and tags are longer. */
  .cols,
  .row {
    display: grid;
    grid-template-columns: 5ch 4.4ch minmax(0, 1fr) 5ch 5.6ch 34px;
    align-items: center;
    column-gap: 5px;
    width: 100%;
  }

  .receipt:lang(en) .cols,
  .receipt:lang(en) .row {
    grid-template-columns: 5ch 8ch minmax(0, 1fr) 5ch 5.6ch 62px;
  }

  .cols {
    height: 22px;
    color: var(--ink-3);
    border-bottom: 1px dashed var(--line);
  }

  .cols span {
    font-size: 9px;
  }

  .row .m {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .r {
    text-align: right;
  }

  .row {
    height: 26px;
    padding: 0;
    border: 0;
    border-bottom: 1px solid var(--line-2);
    border-radius: var(--radius-xs);
    background: transparent;
    color: inherit;
    font: inherit;
    text-align: left;
    cursor: pointer;
    white-space: nowrap;
    transition:
      background-color 0.18s,
      box-shadow 0.18s;
  }

  .row:hover,
  .row.sel {
    background: var(--teal-tint);
  }

  .row.sel {
    box-shadow: inset 2px 0 0 var(--teal);
  }

  .row:focus-visible {
    outline: 2px solid var(--teal);
    outline-offset: -2px;
  }

  .t {
    color: var(--ink-3);
  }

  .m {
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .tag {
    justify-self: end;
    padding: 0 5px;
    border: 1px solid var(--teal-line);
    border-radius: var(--radius-full);
    background: var(--teal-tint);
    color: var(--teal-2);
    font-size: 9px;
    line-height: 14px;
  }

  /* An estimate reads as one: outlined tag, grey figure, dotted underline. */
  .tag.est {
    border: 1px dashed var(--ink-3);
    background: transparent;
    color: var(--ink-3);
  }

  .amt.est {
    color: var(--ink-3);
    text-decoration: underline dotted;
    text-underline-offset: 3px;
  }

  .cap {
    height: calc(18px * var(--f));
    overflow: hidden;
    border-top: 1.5px dashed var(--teal);
    margin-top: 3px;
    text-align: right;
  }

  .cap span {
    display: inline-block;
    margin-top: 2px;
    padding: 0 6px;
    border-radius: var(--radius-xs);
    background: var(--teal-tint);
    color: var(--teal-2);
    font-size: 9px;
    line-height: 13px;
  }

  .cap.hit span {
    background: var(--teal);
    color: var(--on-teal);
  }

  .totals {
    padding-top: 8px;
  }

  .sum {
    display: flex;
    justify-content: space-between;
    height: 20px;
    align-items: center;
    font-size: 11px;
  }

  .sum.est {
    color: var(--ink-3);
  }

  .sum b {
    font-weight: 600;
  }

  .tail {
    height: 6px;
  }

  /* A stamp on the paper: ink with a teal border, slightly crooked, never red. */
  .stamp {
    position: absolute;
    left: 50%;
    top: 46%;
    translate: -50% -50%;
    z-index: 3;
    max-width: 70%;
    padding: 5px 10px;
    border: 2px solid var(--teal);
    border-radius: var(--radius-sm);
    background: color-mix(in srgb, var(--paper) 70%, transparent);
    color: var(--ink);
    font-family: var(--font-sans);
    font-size: 12px;
    font-weight: 700;
    line-height: 1.3;
    text-align: center;
    transform: rotate(-7deg);
    pointer-events: none;
    -webkit-user-select: none;
    user-select: none;
    animation: land 0.32s cubic-bezier(0.2, 1.4, 0.4, 1) both;
  }

  .stamp.released {
    border-style: dashed;
    border-color: var(--teal-line);
    color: var(--ink-2);
    font-weight: 600;
  }

  @keyframes land {
    from {
      opacity: 0;
      transform: rotate(-7deg) scale(1.7);
    }
    to {
      opacity: 1;
      transform: rotate(-7deg) scale(1);
    }
  }

  .release {
    height: 38px;
    padding-top: 8px;
    text-align: center;
  }

  .lift {
    height: 28px;
    padding: 0 16px;
    border: 0;
    border-radius: var(--radius-full);
    background: var(--teal);
    color: var(--on-teal);
    font: 600 12px var(--font-sans);
    cursor: pointer;
    transition:
      background-color 0.15s,
      transform 0.15s;
  }

  .lift:hover {
    background: var(--teal-2);
  }

  .lift:active {
    transform: scale(0.96);
  }

  .lift:focus-visible {
    outline: 2px solid var(--teal);
    outline-offset: 2px;
  }

  @container (max-width: 560px) {
    .part {
      --h: 24px;
    }

    .row {
      height: 24px;
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .stamp {
      animation: none;
    }

    .row,
    .lift {
      transition: none;
    }
  }
</style>
