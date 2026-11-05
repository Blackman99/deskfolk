<script lang="ts">
  import { onDestroy } from 'svelte';
  import { clamp } from '../motion';
  import type { SceneProps } from '../scene';
  import { useStage } from '../stage.svelte';
  import Stand from '../Stand.svelte';
  import type { Kind } from '../file-kind';
  import DroppedPreview from './preview/DroppedPreview.svelte';
  import Glyph from './preview/Glyph.svelte';
  import Pins, { type Pin } from './preview/Pins.svelte';
  import SamplePreview from './preview/SamplePreview.svelte';
  import { openFile, type Shown } from './preview/dropped';

  /**
   * "Toss your own file in": a small app window where the five sample files open one after another
   * beside a file list, a note is pinned on the last and sent to Pudding. Real files dropped on the
   * page (or picked, on a touch screen) open here too, read in the browser and never uploaded.
   */
  let { copy, p, active, lang }: SceneProps<'preview'> = $props();
  const stage = useStage();


  const KEYS = ['poster', 'film', 'pdf', 'sheet', 'doc'] as const;
  type Key = (typeof KEYS)[number];
  type Sel = Key | 'drop';
  const KIND: Record<Key, Kind> = { poster: 'image', film: 'video', pdf: 'pdf', sheet: 'office', doc: 'markdown' };

  // User mode: once the reader touches the scene it stops following the scroll, until they leave.
  let userMode = $state(false);
  let userSel = $state<Sel>('poster');
  let userPins = $state<Pin[]>([]);
  let userToast = $state<number | null>(null);
  let dropped = $state.raw<Shown | null>(null);
  let dragging = $state(false);
  let depth = 0;
  let toastTimer = 0;
  let picker: HTMLInputElement | undefined = $state();

  const autoSel = $derived<Key>(p < 0.15 ? 'poster' : KEYS[Math.min(4, Math.floor(((p - 0.15) / 0.6) * 5))]);
  const sel = $derived<Sel>(userMode ? userSel : autoSel);
  const autoPins = $derived<Pin[]>(p >= 0.75 ? [{ n: 1, x: 47, y: 27, text: copy.note, sent: p >= 0.85 }] : []);
  const pins = $derived(userMode ? userPins : autoPins);
  const toast = $derived(userMode ? userToast : p >= 0.85 ? 1 : null);
  const selKind = $derived<Kind>(sel === 'drop' ? (dropped?.kind ?? 'unknown') : KIND[sel]);
  // Video and audio keep a strip of their own at the bottom so their controls stay clickable.
  const hasControls = $derived(selKind === 'video' || selKind === 'audio');

  const kindOf = (key: Key): Kind => (key === 'sheet' ? 'office' : key === 'doc' ? 'markdown' : KIND[key]);

  function enterUser() {
    if (userMode) return;
    userSel = autoSel;
    userPins = [];
    userToast = null;
    userMode = true;
  }

  function choose(next: Sel) {
    enterUser();
    userSel = next;
    userPins = [];
    userToast = null;
  }

  function place(x: number, y: number) {
    enterUser();
    const kept = userPins.filter((q) => q.sent);
    userPins = [...kept, { n: kept.length + 1, x: clamp(x, 3, 97), y: clamp(y, 4, 96), text: '', sent: false }];
  }

  function setText(n: number, text: string) {
    userPins = userPins.map((q) => (q.n === n ? { ...q, text } : q));
  }

  function send(pin: Pin) {
    userPins = userPins.map((q) => (q.n === pin.n ? { ...q, sent: true } : q));
    userToast = userPins.length;
    clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => (userToast = null), 4200);
  }

  function dispose(s: Shown | null) {
    if (s?.url) URL.revokeObjectURL(s.url);
  }

  async function take(file: File | undefined) {
    if (!file) return;
    const shown = await openFile(file);
    dispose(dropped);
    dropped = shown;
    choose('drop');
  }

  const hasFiles = (e: DragEvent) => Array.from(e.dataTransfer?.types ?? []).includes('Files');

  // Real drops: only while the reader is on this chapter, only for files.
  $effect(() => {
    if (!active) {
      userMode = false;
      userPins = [];
      userToast = null;
      dragging = false;
      depth = 0;
      return;
    }
    const enter = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth++;
      dragging = true;
    };
    const over = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
      dragging = true;
    };
    const leave = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      depth = Math.max(0, depth - 1);
      if (depth === 0) dragging = false;
    };
    const drop = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth = 0;
      dragging = false;
      void take(e.dataTransfer?.files?.[0]);
    };
    const reset = () => {
      depth = 0;
      dragging = false;
    };
    addEventListener('dragenter', enter);
    addEventListener('dragover', over);
    addEventListener('dragleave', leave);
    addEventListener('drop', drop);
    addEventListener('dragend', reset);
    addEventListener('blur', reset);
    return () => {
      removeEventListener('dragenter', enter);
      removeEventListener('dragover', over);
      removeEventListener('dragleave', leave);
      removeEventListener('drop', drop);
      removeEventListener('dragend', reset);
      removeEventListener('blur', reset);
      clearTimeout(toastTimer);
    };
  });

  onDestroy(() => {
    dispose(dropped);
    clearTimeout(toastTimer);
  });

  $effect(() => {
    if (!active) return;
    if (dragging) {
      stage.act('mochi', { pose: 'look', say: null, held: null, away: false, mirror: true });
      stage.act('pudding', { pose: 'hop', say: null, held: null, away: false, mirror: false });
    } else if (toast !== null) {
      stage.act('mochi', { pose: 'point', say: null, held: null, away: false, mirror: true });
      stage.act('pudding', { pose: 'work', say: copy.received(toast), held: null, away: false, mirror: false });
    } else {
      const carry = !userMode && p < 0.15;
      stage.act('mochi', { pose: 'point', say: null, held: null, away: false, mirror: true });
      stage.act('pudding', { pose: carry ? 'carry' : 'idle', say: null, held: carry ? 'file' : null, away: false, mirror: false });
    }
  });

</script>

<div class="scene-root" class:is-wide={stage.wide} class:is-still={stage.reduced}>
  <div class="window" role="group" aria-label={copy.tabTitle}>
    <div class="bar">
      <span class="lights" aria-hidden="true"><i></i><i></i><i></i></span>
      <span class="tab">{copy.tabTitle}</span>
    </div>
    <div class="body">
      <ul class="list" aria-label={copy.fileList}>
        {#each KEYS as key}
          <li>
            <button type="button" class="file" class:is-on={sel === key} aria-pressed={sel === key} onclick={() => choose(key)}>
              <Glyph kind={kindOf(key)} />
              <span class="name">{copy.samples[key]}</span>
            </button>
          </li>
        {/each}
        {#if dropped}
          <li>
            <button type="button" class="file" class:is-on={sel === 'drop'} aria-pressed={sel === 'drop'} onclick={() => choose('drop')}>
              <Glyph kind={dropped.kind} />
              <span class="name">{dropped.name}</span>
            </button>
          </li>
        {/if}
      </ul>
      <div class="view">
        <p class="annot-hint">{copy.annotateHint}</p>
        <div class="area" aria-label={copy.previewLabel}>
          {#key sel}
            <div class="open">
              {#if sel === 'drop' && dropped}
                <DroppedPreview shown={dropped} {copy} />
              {:else if sel !== 'drop'}
                <SamplePreview which={sel} {copy} {lang} />
              {/if}
            </div>
          {/key}
          <Pins
            {pins}
            {userMode}
            {hasControls}
            label={copy.annotateHint}
            placeholder={copy.annotationPlaceholder}
            sendLabel={copy.send}
            onplace={place}
            ontext={setText}
            onsend={send}
          />
          {#if sel === 'drop'}<span class="badge">{copy.local}</span>{/if}
          {#if toast !== null}
            <div class="toast" role="status">{copy.received(toast)}</div>
          {/if}
        </div>
      </div>
    </div>
  </div>

  <div class="foot">
    <div class="spot"><Stand who="pudding" size={stage.wide ? 100 : 76} /></div>
    <div class="hintbox">
      <p class="hint">{copy.dropHint}</p>
      <button type="button" class="pick" onclick={() => picker?.click()}>{copy.pick}</button>
      <input
        bind:this={picker}
        type="file"
        class="sr"
        tabindex="-1"
        aria-hidden="true"
        onchange={(e) => {
          void take(e.currentTarget.files?.[0]);
          e.currentTarget.value = '';
        }}
      />
    </div>
    <div class="spot"><Stand who="mochi" size={stage.wide ? 100 : 76} /></div>
  </div>

  {#if dragging}
    <div class="catch" aria-hidden="true"><span>{copy.dropNow}</span></div>
  {/if}
</div>

<style>
  .scene-root {
    position: relative;
    display: flex;
    flex-direction: column;
    gap: 6px;
    width: 100%;
  }

  .scene-root.is-wide {
    height: 100%;
  }

  .window {
    display: flex;
    flex-direction: column;
    background: var(--paper);
    border: 1px solid var(--line);
    border-radius: var(--radius-lg);
    box-shadow: var(--shadow-window);
    overflow: hidden;
    height: 340px;
  }

  .is-wide .window {
    flex: 1;
    min-height: 0;
    height: auto;
  }

  .bar {
    display: flex;
    align-items: flex-end;
    gap: 14px;
    height: 34px;
    padding: 0 12px;
    background: var(--ground);
    border-bottom: 1px solid var(--line);
    flex: none;
  }

  .lights {
    display: flex;
    gap: 5px;
    align-self: center;
  }

  .lights i {
    width: 9px;
    height: 9px;
    border-radius: 50%;
    background: var(--line);
  }

  .tab {
    padding: 6px 14px;
    font-size: 12px;
    color: var(--ink);
    background: var(--paper);
    border: 1px solid var(--line);
    border-bottom: 0;
    border-radius: var(--radius-sm) var(--radius-sm) 0 0;
    margin-bottom: -1px;
    white-space: nowrap;
  }

  .body {
    flex: 1;
    min-height: 0;
    display: flex;
  }

  .list {
    list-style: none;
    margin: 0;
    padding: 8px 6px;
    width: 150px;
    flex: none;
    display: flex;
    flex-direction: column;
    gap: 2px;
    border-right: 1px solid var(--line);
    background: var(--ground-2);
    overflow: auto;
  }

  .file {
    width: 100%;
    display: flex;
    align-items: center;
    gap: 7px;
    padding: 6px 8px;
    border: 0;
    border-radius: var(--radius-sm);
    background: transparent;
    color: var(--ink-2);
    font: inherit;
    font-size: 12px;
    text-align: left;
    cursor: pointer;
    transition-property: background-color, color;
    transition-duration: 0.15s;
  }

  .file:hover {
    background: var(--ground);
  }

  .file.is-on {
    background: var(--teal-tint);
    color: var(--teal-2);
    box-shadow: inset 0 0 0 1px var(--teal-line);
  }

  .file:focus-visible,
  .pick:focus-visible {
    outline: 2px solid var(--teal);
    outline-offset: 1px;
  }

  .name {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .view {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    padding: 6px 8px 8px;
    gap: 4px;
  }

  .annot-hint {
    margin: 0;
    font-size: 11px;
    color: var(--ink-3);
    flex: none;
  }

  .area {
    position: relative;
    flex: 1;
    min-height: 0;
    border: 1px solid var(--line);
    border-radius: var(--radius-md);
    overflow: hidden;
    background: var(--ground-2);
  }

  .open {
    position: absolute;
    inset: 0;
    animation: open 0.28s cubic-bezier(0.2, 0.7, 0.2, 1) both;
  }

  @keyframes open {
    from {
      opacity: 0;
      transform: translateY(8px) scale(0.985);
    }
  }

  .badge {
    position: absolute;
    top: 8px;
    right: 8px;
    z-index: 3;
    padding: 2px 9px;
    font-size: 11px;
    border-radius: var(--radius-full);
    background: var(--teal-tint);
    color: var(--teal-2);
    border: 1px solid var(--teal-line);
    pointer-events: none;
  }

  .toast {
    position: absolute;
    left: 50%;
    bottom: 10px;
    z-index: 4;
    transform: translateX(-50%);
    max-width: 90%;
    padding: 6px 14px;
    font-size: 12.5px;
    border-radius: var(--radius-full);
    background: var(--teal);
    color: var(--on-teal);
    box-shadow: var(--shadow-float);
    white-space: nowrap;
    animation: toast 0.3s ease-out both;
    pointer-events: none;
  }

  @keyframes toast {
    from {
      opacity: 0;
      transform: translate(-50%, 8px);
    }
  }

  .foot {
    display: flex;
    align-items: flex-end;
    justify-content: space-between;
    gap: 8px;
    flex: none;
    padding-top: 40px;
  }

  .is-wide .foot {
    padding-top: 30px;
  }

  .hintbox {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 8px;
    padding-bottom: 10px;
    text-align: center;
  }

  .hint {
    margin: 0;
    font-size: 12.5px;
    line-height: 1.5;
    color: var(--ink-3);
    text-wrap: balance;
  }

  .pick {
    padding: 5px 14px;
    font: inherit;
    font-size: 12.5px;
    color: var(--teal-2);
    background: var(--teal-tint);
    border: 1px solid var(--teal-line);
    border-radius: var(--radius-full);
    cursor: pointer;
  }

  .pick:hover {
    background: var(--paper);
  }

  .sr {
    position: absolute;
    width: 1px;
    height: 1px;
    opacity: 0;
    pointer-events: none;
  }

  /* Over the whole scene while a file is carried over the page. */
  .catch {
    position: absolute;
    inset: -8px;
    z-index: 10;
    display: grid;
    place-items: center;
    border: 2px dashed var(--teal);
    border-radius: var(--radius-xl);
    background: color-mix(in srgb, var(--teal-tint) 82%, transparent);
    pointer-events: none;
    animation: fade 0.15s ease-out both;
  }

  .catch span {
    padding: 8px 18px;
    font-size: 15px;
    font-weight: 600;
    color: var(--teal-2);
    background: var(--paper);
    border-radius: var(--radius-full);
    box-shadow: var(--shadow-float);
  }

  @keyframes fade {
    from {
      opacity: 0;
    }
  }

  @media (max-width: 560px) {
    .window {
      height: 320px;
    }

    .body {
      flex-direction: column;
    }

    .list {
      width: auto;
      flex-direction: row;
      border-right: 0;
      border-bottom: 1px solid var(--line);
      padding: 6px;
      gap: 4px;
    }

    .list li {
      flex: none;
    }

    .file {
      width: auto;
      padding: 5px 10px;
      border-radius: var(--radius-full);
      white-space: nowrap;
    }

    .name {
      max-width: 110px;
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .open,
    .toast,
    .catch {
      animation: none;
    }

    .file {
      transition: none;
    }
  }
</style>
