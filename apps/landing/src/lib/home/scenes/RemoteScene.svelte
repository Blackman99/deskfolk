<script lang="ts">
  import { onMount, untrack } from 'svelte';
  import { base } from '$app/paths';
  import { lerp, span } from '../motion';
  import {
    INITIAL,
    autoState,
    reduce,
    rippleAt,
    type RemoteAction,
    type RemoteState
  } from '../remote-channel';
  import type { SceneProps } from '../scene';
  import Stand from '../Stand.svelte';
  import { useStage } from '../stage.svelte';
  import PhoneUI from './PhoneUI.svelte';
  import { openRemoteLink, type RemoteLink } from './remote/channel';
  import DeskWindow from './remote/DeskWindow.svelte';

  /**
   * Remote control, played for real: Pudding works at the desk while Mochi, out of the house, walks
   * to a phone and approves, stops and resumes from it. The beats follow the scroll until a button
   * is pressed (here or in the pop-up phone, which talks to this page over a BroadcastChannel); then
   * what you do is what happens, until you leave the chapter or press Replay.
   */
  let { copy, p, active, lang }: SceneProps<'remote'> = $props();
  const stage = useStage();

  // ---- state: the scroll's, until someone presses something ----
  let userMode = $state(false);
  let userState = $state.raw<RemoteState>(INITIAL);
  const shown = $derived(userMode ? userState : autoState(p));
  const ripple = $derived(userMode || stage.reduced ? null : rippleAt(p));

  function apply(action: RemoteAction) {
    userState = reduce(untrack(() => shown), action);
    userMode = true;
  }

  function fromPhone(action: RemoteAction) {
    apply(action);
    link?.send({ type: 'action', action });
  }

  function replay() {
    if (stage.reduced) {
      // Nothing scrolls with reduced motion: start again at the approval.
      userState = reduce(INITIAL, { type: 'ask' });
      userMode = true;
    } else {
      userMode = false;
    }
  }

  // Back to the scroll's story once the reader leaves the chapter.
  $effect(() => {
    if (!active) userMode = false;
  });

  // ---- the pop-up phone ----
  let link: RemoteLink | null = $state.raw(null);
  let canPopup = $state(false);
  let blocked = $state(false);
  const href = $derived(`${base}/phone/${lang}`);

  onMount(() => {
    const l = openRemoteLink((m) => {
      if (m.type === 'action') apply(m.action);
      else if (m.type === 'hello') l?.send({ type: 'state', state: untrack(() => shown) });
    });
    link = l;
    canPopup = l !== null;
    return () => {
      l?.close();
      link = null;
    };
  });

  // The pop-up follows this page: send the state whenever it really changes.
  const key = $derived(`${shown.phase}|${shown.tab}|${shown.denied}`);
  $effect(() => {
    void key;
    if (!link || !(active || userMode)) return;
    link.send({ type: 'state', state: untrack(() => shown) });
  });

  function openPhone(e: MouseEvent) {
    e.preventDefault();
    const w = window.open(href, 'deskfolk-phone', 'popup,width=390,height=800');
    blocked = w === null;
  }

  // ---- layout: where the two companions stand ----
  const S_WIDE = 96;
  const S_NARROW = 72;
  let root: HTMLElement | undefined = $state();
  let deskBox: HTMLElement | undefined = $state();
  let phoneBox: HTMLElement | undefined = $state();
  let geo = $state({ w: 0, two: true, deskBottom: 0, phoneL: 0, phoneBottom: 0 });

  onMount(() => {
    if (!root) return;
    const measure = () => {
      if (!root || !deskBox || !phoneBox) return;
      geo = {
        w: root.clientWidth,
        two: root.clientWidth >= 600,
        deskBottom: deskBox.offsetTop + deskBox.offsetHeight,
        phoneL: phoneBox.offsetLeft,
        phoneBottom: phoneBox.offsetTop + phoneBox.offsetHeight
      };
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(root);
    ro.observe(phoneBox!);
    ro.observe(deskBox!);
    return () => ro.disconnect();
  });

  const S = $derived(geo.two ? S_WIDE : S_NARROW);
  // Pudding stays at the desk; Mochi walks from beside the desk to beside the phone.
  const pudding = $derived(
    geo.two
      ? { x: 6, y: geo.phoneBottom - S }
      : { x: geo.w - S - 4, y: geo.deskBottom - S + 18 }
  );
  const mochiFrom = $derived(
    geo.two ? { x: 6 + S + 10, y: geo.phoneBottom - S } : { x: 4, y: geo.deskBottom - S + 18 }
  );
  const mochiTo = $derived(
    geo.two
      ? { x: geo.phoneL - S - 6, y: geo.phoneBottom - S }
      : { x: geo.phoneL - S + 10, y: geo.phoneBottom - S - 8 }
  );
  const walk = $derived(span(p, 0, 0.2));
  const mochi = $derived({ x: lerp(mochiFrom.x, mochiTo.x, walk), y: lerp(mochiFrom.y, mochiTo.y, walk) });
  const arrived = $derived(p >= 0.2);

  // ---- the companions' poses ----
  $effect(() => {
    if (!active) return;
    const phase = shown.phase;
    if (phase === 'working') stage.act('pudding', { pose: 'work', say: null, held: null, away: false, mirror: false });
    else if (phase === 'waiting')
      stage.act('pudding', { pose: 'ask', say: copy.status.waiting, held: null, away: false, mirror: false });
    else if (phase === 'stopped') stage.act('pudding', { pose: 'rest', say: null, held: null, away: false, mirror: false });
    else stage.act('pudding', { pose: 'cheer', say: copy.chat.doneBot, held: null, away: false, mirror: false });
  });

  $effect(() => {
    if (!active) return;
    if (arrived) stage.act('mochi', { pose: 'look', say: null, held: 'phone', away: false, mirror: false });
    else stage.act('mochi', { pose: 'walk', say: null, held: null, away: false, mirror: false });
  });
</script>

<div class="remote" class:wide={stage.wide} class:two={geo.two} bind:this={root}>
  <div class="left">
    <div class="controls">
      {#if canPopup}
        <a class="open" {href} target="_blank" rel="noopener" onclick={openPhone}>{copy.openPhone}</a>
      {/if}
      <button type="button" class="replay" onclick={replay}>{copy.replay}</button>
      {#if canPopup}<p class="hint">{blocked ? copy.popupBlocked : copy.openHint}</p>{/if}
    </div>
    <div class="desk-box" bind:this={deskBox}>
      <DeskWindow {copy} state={shown} {lang} />
    </div>
  </div>

  <div class="phone-box" bind:this={phoneBox}>
    <PhoneUI {copy} state={shown} {lang} send={fromPhone} {ripple} />
  </div>

  <div class="spot" style:transform="translate3d({pudding.x}px, {pudding.y}px, 0)">
    <Stand who="pudding" size={S} />
  </div>
  <div class="spot" style:transform="translate3d({mochi.x}px, {mochi.y}px, 0)">
    <Stand who="mochi" size={S} />
  </div>
  <span class="away" class:on={arrived} style:transform="translate3d({mochiTo.x}px, {mochiTo.y - 4}px, 0)">
    {copy.away}
  </span>
</div>

<style>
  .remote {
    position: relative;
    display: flex;
    flex-direction: column;
    gap: 12px;
    width: 100%;
    height: 100%;
    padding: 0 0 4px;
  }

  .left {
    display: flex;
    flex-direction: column;
    gap: 10px;
    min-width: 0;
  }

  .controls {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 6px 12px;
    font-size: 12.5px;
  }

  .open {
    color: var(--teal);
    font-weight: 600;
    text-decoration: underline;
    text-underline-offset: 3px;
  }

  .replay {
    padding: 3px 10px;
    border-radius: 999px;
    border: 1px solid var(--line-2);
    background: var(--paper);
    color: var(--ink-2);
    font: inherit;
    cursor: pointer;
  }

  .replay:hover {
    background: var(--ground-2);
  }

  .open:focus-visible,
  .replay:focus-visible {
    outline: 2px solid var(--teal);
    outline-offset: 2px;
  }

  .hint {
    flex-basis: 100%;
    margin: 0;
    color: var(--ink-3);
    font-size: 11.5px;
    line-height: 1.4;
  }

  .desk-box {
    min-height: 196px;
  }

  .phone-box {
    width: 236px;
    height: 400px;
    margin: 0 auto;
    flex: none;
  }

  /* Side by side from 600 px: the desk (with room under it for the two companions) and the phone. */
  .remote.two {
    display: grid;
    grid-template-columns: minmax(0, 1fr) 260px;
    gap: 20px;
    align-items: end;
  }

  .two .left {
    align-self: stretch;
    padding-bottom: 104px;
  }

  .two .desk-box {
    flex: 1;
    min-height: 260px;
  }

  .two .phone-box {
    width: 260px;
    height: min(530px, 100%);
    min-height: 480px;
    margin: 0;
  }

  .two:not(.wide) {
    height: auto;
  }

  .spot {
    position: absolute;
    left: 0;
    top: 0;
    pointer-events: none;
    will-change: transform;
  }

  .spot :global(.stand) {
    pointer-events: auto;
  }

  .away {
    position: absolute;
    left: 0;
    top: 0;
    padding: 1px 8px;
    border-radius: 999px;
    background: var(--paper);
    border: 1px solid var(--line-2);
    color: var(--ink-2);
    font-size: 11px;
    white-space: nowrap;
    opacity: 0;
    pointer-events: none;
    transition: opacity 0.3s;
  }

  .away.on {
    opacity: 1;
  }

  @media (prefers-reduced-motion: reduce) {
    .away {
      transition: none;
    }
  }
</style>
