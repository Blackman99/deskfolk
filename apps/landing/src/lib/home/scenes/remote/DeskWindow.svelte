<script lang="ts">
  import type { SceneCopy } from '../../copy';
  import type { RemoteState } from '../../remote-channel';
  import type { Lang } from '$lib/i18n';

  /**
   * The computer's side of the remote demo: a small Deskfolk chat with Pudding's message, the
   * approval card (which only shows it is waiting: you approve from the phone) and the status line.
   * It fills the box it is given, so the phone's Mac-screen tab can show the very same window scaled down.
   */
  let { copy, state: rs, lang }: { copy: SceneCopy['remote']; state: RemoteState; lang: Lang } = $props();
</script>

<div class="desk">
  <div class="bar" aria-hidden="true">
    <i></i><i></i><i></i>
    <span>{copy.deskTitle}</span>
  </div>
  <div class="main">
  <ul class="side" aria-hidden="true">
    {#each copy.sidebar as name, i}
      <li class:on={i === 1}><i></i>{name}</li>
    {/each}
  </ul>
  <div class="body">
    {#each copy.chat.history as m}
      <p class="msg" class:mine={m.mine}>{m.text}</p>
    {/each}
    <p class="msg">{copy.chat.bot}</p>
    {#if rs.phase === 'waiting'}
      <div class="card">
        <b>{copy.approval.head}</b>
        <code>{copy.approval.tool}</code>
        <span class="wait"><i></i>{copy.waiting}</span>
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
  </div>
  <div class="status" data-phase={rs.phase} role="status">
    <i class="dot"></i>
    <span>{copy.status[rs.phase]}</span>
  </div>
</div>

<style>
  .desk {
    height: 100%;
    display: flex;
    flex-direction: column;
    background: var(--paper);
    border: 1px solid var(--line);
    border-radius: var(--radius-lg);
    box-shadow: var(--shadow-window);
    overflow: hidden;
    color: var(--ink);
    font-size: 13px;
    line-height: 1.45;
    text-align: start;
  }

  .bar {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 0 12px;
    height: 32px;
    flex: none;
    background: var(--ground-2);
    border-bottom: 1px solid var(--line);
    color: var(--ink-3);
    font-size: 12px;
  }

  .bar i {
    width: 9px;
    height: 9px;
    border-radius: 50%;
    background: var(--line-2);
  }

  .bar span {
    margin-inline-start: 8px;
  }

  .main {
    flex: 1;
    min-height: 0;
    display: flex;
  }

  /* The window's sidebar, cut down to three conversations; Pudding's direct chat is open. */
  .side {
    flex: none;
    width: 30%;
    max-width: 150px;
    margin: 0;
    padding: 10px 6px;
    list-style: none;
    display: flex;
    flex-direction: column;
    gap: 2px;
    background: var(--ground);
    border-inline-end: 1px solid var(--line);
    font-size: 12px;
    color: var(--ink-2);
  }

  .side li {
    display: flex;
    align-items: center;
    gap: 7px;
    padding: 6px 8px;
    border-radius: var(--radius-sm);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .side li i {
    flex: none;
    width: 14px;
    height: 14px;
    border-radius: 4px;
    background: var(--line);
  }

  .side li:nth-child(2) i {
    background: var(--mustard);
  }

  .side li.on {
    background: var(--teal-tint);
    color: var(--teal-2);
    font-weight: 600;
  }

  .body {
    flex: 1;
    min-width: 0;
    min-height: 0;
    padding: 12px;
    display: flex;
    flex-direction: column;
    gap: 8px;
    overflow: hidden;
  }

  .msg {
    margin: 0;
    max-width: 88%;
    padding: 8px 11px;
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
    padding: 10px 12px;
    border: 1px solid var(--line-2);
    border-radius: var(--radius-md);
    background: var(--paper);
  }

  .card code {
    font-family: var(--font-mono);
    font-size: 12px;
    color: var(--ink-2);
  }

  .wait {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    margin-top: 2px;
    color: var(--ink-2);
    font-size: 12px;
  }

  .wait i {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    border: 1.5px solid var(--ink-3);
    animation: pulse 1.6s ease-in-out infinite;
  }

  .note {
    margin: 0;
    color: var(--ink-3);
    font-size: 12px;
  }

  .status {
    flex: none;
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 9px 12px;
    border-top: 1px solid var(--line);
    color: var(--ink-2);
    font-size: 12.5px;
  }

  .dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--ink-3);
    flex: none;
  }

  .status[data-phase='working'] .dot {
    background: var(--teal);
    animation: pulse 1.4s ease-in-out infinite;
  }

  .status[data-phase='done'] .dot {
    background: var(--teal);
  }

  @keyframes pulse {
    50% {
      opacity: 0.35;
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .wait i,
    .status[data-phase='working'] .dot {
      animation: none;
    }
  }
</style>
