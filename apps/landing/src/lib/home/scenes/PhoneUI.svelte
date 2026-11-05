<script lang="ts">
  import { onDestroy } from 'svelte';
  import type { SceneCopy } from '../copy';
  import type { RemoteAction, RemoteState, RippleTarget, Tab } from '../remote-channel';
  import DeskWindow from './remote/DeskWindow.svelte';
  import type { Lang } from '$lib/i18n';

  /**
   * The paired phone: a Home Screen web page with the chats, the workspace, a terminal and the Mac's
   * screen. It draws `state` and reports taps through `send`; whoever owns the state decides what
   * a tap does. `framed` puts it in a phone bezel; unframed it fills its box (the pop-up window).
   */
  let {
    copy,
    state: rs,
    lang,
    send,
    framed = true,
    ripple = null
  }: {
    copy: SceneCopy['remote'];
    state: RemoteState;
    lang: Lang;
    send: (action: RemoteAction) => void;
    framed?: boolean;
    /** A tap ripple to draw on one button (the scene's automatic beats). */
    ripple?: { target: RippleTarget; t: number } | null;
  } = $props();


  const DESK_W = 360;
  const DESK_H = 300;
  let screenW = $state(DESK_W);
  const scale = $derived(screenW / DESK_W);

  // The push banner slides in when Pudding starts waiting, stays a moment, and goes.
  let banner = $state(false);
  let prevPhase: string | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  $effect(() => {
    const phase = rs.phase;
    if (phase === 'waiting' && prevPhase !== 'waiting') {
      banner = true;
      clearTimeout(timer);
      timer = setTimeout(() => (banner = false), 3400);
    } else if (phase !== 'waiting') {
      banner = false;
    }
    prevPhase = phase;
  });
  onDestroy(() => clearTimeout(timer));

  // Called only from tap handlers, so a vibration is always inside a user gesture.
  function tap(action: RemoteAction) {
    try {
      navigator.vibrate?.(30);
    } catch {
      /* no haptics here */
    }
    send(action);
  }

  const goTab = (tab: Tab) => tap({ type: 'tab', tab });
  const tabs = [0, 1, 2, 3] as const;
  const ripples = $derived(ripple ?? null);
</script>

{#snippet tapMark(target: RippleTarget)}
  {#if ripples?.target === target}
    <span
      class="ripple"
      aria-hidden="true"
      style:--t={ripples.t}
    ></span>
  {/if}
{/snippet}

<div class="phone" class:framed aria-label={copy.phoneLabel} role="group">
  <div class="screen">
    <div class="status-bar" aria-hidden="true">
      <span>9:41</span>
      <span class="sig"><i></i><i></i><i></i></span>
    </div>

    <div class="banner" class:on={banner} aria-hidden={!banner}>
      <span class="app">Deskfolk</span>
      <span>{copy.push}</span>
    </div>

    <div class="content">
      {#if rs.tab === 0}
        <div class="chat">
          {#each copy.chat.history as m}
            <p class="msg" class:mine={m.mine}>{m.text}</p>
          {/each}
          <p class="msg">{copy.chat.bot}</p>
          {#if rs.phase === 'waiting'}
            <div class="card">
              <b>{copy.approval.head}</b>
              <code>{copy.approval.tool}</code>
              <div class="actions">
                <button type="button" class="btn primary" onclick={() => tap({ type: 'allow' })}>
                  {copy.approval.allowOnce}{@render tapMark('allow')}
                </button>
                <button type="button" class="btn" onclick={() => tap({ type: 'deny' })}>{copy.approval.deny}</button>
              </div>
            </div>
          {/if}
          {#if rs.denied && rs.phase === 'working'}
            <p class="note">{copy.denied}</p>
          {/if}
          {#if rs.phase === 'done'}
            <p class="msg mine">{copy.chat.you}</p>
            <p class="msg">{copy.chat.doneBot}</p>
          {/if}
        </div>
        <div class="foot-chat">
          <p class="state" data-phase={rs.phase}>
            {copy.status[rs.phase]}
          </p>
          {#if rs.phase === 'working' || rs.phase === 'waiting'}
            <button type="button" class="btn stop" onclick={() => tap({ type: 'stop' })}>
              {copy.stop}{@render tapMark('stop')}
            </button>
          {:else if rs.phase === 'stopped'}
            <button type="button" class="btn quick" onclick={() => tap({ type: 'resume' })}>
              {copy.resume}{@render tapMark('resume')}
            </button>
          {/if}
        </div>
      {:else if rs.tab === 1}
        <ul class="files">
          {#each copy.files as file (file)}
            <li><i aria-hidden="true"></i><span>{file}</span></li>
          {/each}
        </ul>
      {:else if rs.tab === 2}
        <pre class="term">{#each copy.terminal as line (line)}<span class:ok={line.startsWith('✓')}>{line}</span>
{/each}</pre>
      {:else}
        <div class="mac">
          <div class="mac-box" bind:clientWidth={screenW} style:height="{DESK_H * scale}px">
            <div
              class="mac-inner"
              aria-label={copy.screenLabel}
              role="img"
              style:width="{DESK_W}px"
              style:height="{DESK_H}px"
              style:transform="scale({scale})"
            >
              <DeskWindow {copy} state={rs} {lang} />
            </div>
            <span class="badge">{copy.direct}</span>
          </div>
          <p class="hint">{copy.screenHint}</p>
        </div>
      {/if}
    </div>

    <p class="lock">
      <svg viewBox="0 0 16 16" width="11" height="11" aria-hidden="true">
        <rect x="3" y="7" width="10" height="7" rx="1.6" fill="currentColor" />
        <path d="M5.2 7V5.2a2.8 2.8 0 0 1 5.6 0V7" fill="none" stroke="currentColor" stroke-width="1.6" />
      </svg>
      {copy.e2e} · {copy.relay}
    </p>

    <nav class="tabbar" aria-label={copy.phoneLabel}>
      {#each tabs as i (i)}
        <button type="button" class:on={rs.tab === i} aria-current={rs.tab === i ? 'page' : undefined} onclick={() => goTab(i)}>
          <svg viewBox="0 0 20 20" width="17" height="17" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
            {#if i === 0}
              <path d="M4 5.5h12v7H9.5L6 15.5v-3H4z" />
            {:else if i === 1}
              <path d="M3.5 6.5v8h13v-7h-6l-1.5-2h-5.5z" />
            {:else if i === 2}
              <rect x="3" y="4.5" width="14" height="11" rx="1.6" />
              <path d="M6.5 8.5l2.2 1.7-2.2 1.7M10.5 12h3" />
            {:else}
              <rect x="3" y="4" width="14" height="9.5" rx="1.4" />
              <path d="M7.5 16.5h5M10 13.5v3" />
            {/if}
          </svg>
          <span>{copy.tabs[i]}</span>
        </button>
      {/each}
    </nav>
  </div>
</div>

<style>
  .phone {
    position: relative;
    width: 100%;
    height: 100%;
    color: var(--ink);
    font-size: 12.5px;
    line-height: 1.45;
    text-align: start;
    container-type: inline-size;
  }

  /* The bezel stays dark in both themes, like a real device. */
  .phone.framed {
    padding: 8px;
    border-radius: 36px;
    background: #14191b;
    box-shadow:
      0 0 0 1px var(--line-2),
      var(--shadow-float);
  }

  .phone.framed::before {
    content: '';
    position: absolute;
    top: 14px;
    left: 50%;
    width: 54px;
    height: 5px;
    margin-left: -27px;
    border-radius: 3px;
    background: #14191b;
    z-index: 3;
  }

  .screen {
    position: relative;
    height: 100%;
    display: flex;
    flex-direction: column;
    background: var(--paper);
    overflow: hidden;
  }

  .framed .screen {
    border-radius: 28px;
  }

  .status-bar {
    flex: none;
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 9px 20px 4px;
    font-size: 11px;
    font-weight: 600;
    color: var(--ink);
  }

  .sig {
    display: inline-flex;
    gap: 2px;
    align-items: flex-end;
  }

  .sig i {
    width: 3px;
    background: var(--ink);
    border-radius: 1px;
  }
  .sig i:nth-child(1) { height: 4px; }
  .sig i:nth-child(2) { height: 7px; }
  .sig i:nth-child(3) { height: 10px; }

  .banner {
    position: absolute;
    top: 30px;
    left: 8px;
    right: 8px;
    z-index: 2;
    display: flex;
    flex-direction: column;
    gap: 1px;
    padding: 8px 12px;
    border-radius: var(--radius-lg);
    background: var(--paper);
    border: 1px solid var(--line-2);
    box-shadow: var(--shadow-float);
    transform: translateY(-140%);
    opacity: 0;
    pointer-events: none;
    transition:
      transform 0.45s cubic-bezier(0.2, 0.9, 0.3, 1),
      opacity 0.3s;
  }

  .banner.on {
    transform: none;
    opacity: 1;
  }

  .banner .app {
    font-size: 10.5px;
    color: var(--ink-3);
  }

  .content {
    flex: 1;
    min-height: 0;
    padding: 6px 12px 8px;
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }

  .chat {
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
    gap: 8px;
    overflow: hidden;
  }

  .msg {
    margin: 0;
    max-width: 90%;
    padding: 7px 10px;
    border-radius: var(--radius-md);
    background: var(--ground-2);
    align-self: flex-start;
  }

  .msg.mine {
    align-self: flex-end;
    background: var(--teal-tint);
    border: 1px solid var(--teal-line);
  }

  .card {
    display: flex;
    flex-direction: column;
    gap: 4px;
    padding: 9px 10px;
    border: 1px solid var(--line-2);
    border-radius: var(--radius-md);
  }

  .card code {
    font-family: var(--font-mono);
    font-size: 11.5px;
    color: var(--ink-2);
  }

  .actions {
    display: flex;
    gap: 6px;
    margin-top: 4px;
  }

  .actions .btn {
    flex: 1;
  }

  .note {
    margin: 0;
    color: var(--ink-3);
    font-size: 11.5px;
  }

  .foot-chat {
    flex: none;
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding-top: 6px;
  }

  .state {
    margin: 0;
    color: var(--ink-2);
    font-size: 11.5px;
  }

  .btn {
    position: relative;
    min-height: 34px;
    padding: 0 12px;
    border-radius: var(--radius-md);
    border: 1px solid var(--line-2);
    background: var(--paper);
    color: var(--ink);
    font: inherit;
    font-weight: 600;
    cursor: pointer;
    transition:
      background-color 0.15s,
      border-color 0.15s,
      transform 0.15s;
  }

  .btn:hover {
    background: var(--ground-2);
  }

  .btn:active {
    transform: scale(0.97);
  }

  .btn:focus-visible,
  .tabbar button:focus-visible {
    outline: 2px solid var(--teal);
    outline-offset: 2px;
  }

  .btn.primary,
  .btn.quick {
    background: var(--teal);
    border-color: var(--teal);
    color: var(--on-teal);
  }

  .btn.primary:hover,
  .btn.quick:hover {
    background: var(--teal-2);
    border-color: var(--teal-2);
  }

  .ripple {
    position: absolute;
    left: 50%;
    top: 50%;
    width: 44px;
    height: 44px;
    margin: -22px 0 0 -22px;
    border-radius: 50%;
    border: 2px solid var(--teal);
    background: var(--teal-tint);
    pointer-events: none;
    transform: scale(calc(0.35 + var(--t) * 1.1));
    opacity: calc(1 - var(--t) * 0.55);
  }

  .files {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
  }

  .files li {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 10px 2px;
    border-bottom: 1px solid var(--line);
    font-family: var(--font-mono);
    font-size: 12px;
  }

  .files i {
    width: 11px;
    height: 14px;
    border: 1.5px solid var(--ink-3);
    border-radius: 2px;
    flex: none;
  }

  .term {
    margin: 0;
    padding: 10px 11px;
    border-radius: var(--radius-md);
    background: var(--ground-2);
    border: 1px solid var(--line);
    font-family: var(--font-mono);
    font-size: 11.5px;
    line-height: 1.6;
    color: var(--ink);
    white-space: pre-wrap;
  }

  .term span {
    display: block;
  }

  .term .ok {
    color: var(--teal);
  }

  .mac {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  .mac-box {
    position: relative;
    width: 100%;
    overflow: hidden;
    border-radius: var(--radius-md);
  }

  .mac-inner {
    transform-origin: 0 0;
    pointer-events: none;
    -webkit-user-select: none;
    user-select: none;
  }

  .badge {
    position: absolute;
    top: 6px;
    right: 6px;
    padding: 2px 8px;
    border-radius: 999px;
    background: var(--teal);
    color: var(--on-teal);
    font-size: 10.5px;
    font-weight: 600;
  }

  .hint {
    margin: 0;
    color: var(--ink-3);
    font-size: 11.5px;
  }

  .lock {
    flex: none;
    margin: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 5px;
    padding: 5px 0;
    border-top: 1px solid var(--line);
    color: var(--ink-3);
    font-size: 10.5px;
  }

  .tabbar {
    flex: none;
    display: grid;
    grid-template-columns: repeat(4, 1fr);
    border-top: 1px solid var(--line);
    padding-bottom: 4px;
  }

  .tabbar button {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 2px;
    padding: 7px 2px 3px;
    border: 0;
    background: none;
    color: var(--ink-3);
    font: inherit;
    font-size: 10.5px;
    cursor: pointer;
  }

  .tabbar button.on {
    color: var(--teal);
    font-weight: 600;
  }

  .tabbar button span {
    max-width: 100%;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  /* Unframed (the pop-up window): the page itself is the phone. */
  .phone:not(.framed) {
    font-size: 15px;
  }

  .phone:not(.framed) .status-bar {
    display: none;
  }

  .phone:not(.framed) .banner {
    top: 8px;
  }

  @media (prefers-reduced-motion: reduce) {
    .banner {
      transition: opacity 0.2s;
      transform: none;
    }
    .btn {
      transition: none;
    }
  }
</style>
