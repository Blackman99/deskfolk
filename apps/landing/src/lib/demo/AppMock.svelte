<script lang="ts" module>
  export type FocusRect = { x: number; y: number; w: number; h: number };
</script>

<script lang="ts">
  import { tick } from 'svelte';
  import { fade, fly, scale } from 'svelte/transition';
  import type { BotId, Dict } from '$lib/i18n';
  import Logo from '$lib/Logo.svelte';
  import Avatar from './Avatar.svelte';
  import Typewriter from './Typewriter.svelte';
  import { SCENE_BEATS, stateAt, maxBeat, type MockState, type PaneId, type TranscriptItem } from './scenes';

  export const DESIGN_W = 900;
  export const DESIGN_H = 580;

  let {
    scene,
    t,
    instant = false,
    calloutTarget = null,
    calloutText = null,
    frozenBeat = null,
    skipToEnd = false,
    onFocus
  }: {
    scene: number;
    t: Dict;
    instant?: boolean;
    calloutTarget?: string | null;
    calloutText?: string | null;
    /** With `instant`, show this beat instead of the scene's last one (used by the brand image studio). */
    frozenBeat?: number | null;
    /** Jump straight to the scene's final beat (used when the reader scrolls back up). */
    skipToEnd?: boolean;
    /** Reports the callout target's rectangle in design px so a narrow stage can zoom onto it. */
    onFocus?: (rect: FocusRect | null) => void;
  } = $props();

  let beat = $state(0);
  let winEl: HTMLDivElement | undefined = $state();

  const mock: MockState = $derived(stateAt(scene, beat, t));
  const dur = $derived(instant ? 0 : 260);

  /* ---- Beat scheduling: reset on scene change, replay the scene's timeline. ---- */
  $effect(() => {
    const current = scene;
    const offsets = SCENE_BEATS[current] ?? [];
    beat = 0;
    if (instant || skipToEnd) {
      beat = frozenBeat ?? maxBeat(current);
      return;
    }
    const timers = offsets.map((ms, i) => setTimeout(() => (beat = i + 1), ms));
    return () => timers.forEach(clearTimeout);
  });

  /* ---- Measure a [data-hit] target in design coordinates. ---- */
  function measure(target: string): { x: number; y: number; w: number; h: number } | null {
    if (!winEl) return null;
    const el = winEl.querySelector<HTMLElement>(`[data-hit="${target}"]`);
    if (!el) return null;
    const host = winEl.getBoundingClientRect();
    const s = host.width / DESIGN_W || 1;
    const r = el.getBoundingClientRect();
    return { x: (r.left - host.left) / s, y: (r.top - host.top) / s, w: r.width / s, h: r.height / s };
  }

  /* ---- Cursor ---- */
  let cursor = $state<{ x: number; y: number; visible: boolean; clicking: boolean }>({
    x: 450,
    y: 300,
    visible: false,
    clicking: false
  });

  $effect(() => {
    const c = mock.cursor;
    let cancelled = false;
    let t1: ReturnType<typeof setTimeout> | undefined;
    let t2: ReturnType<typeof setTimeout> | undefined;
    tick().then(() => {
      if (cancelled) return;
      if (!c) {
        cursor = { ...cursor, visible: false, clicking: false };
        return;
      }
      const r = measure(c.target);
      if (!r) return;
      cursor = { x: r.x + r.w / 2, y: r.y + r.h / 2, visible: true, clicking: false };
      if (c.click && !instant) {
        t1 = setTimeout(() => {
          cursor = { ...cursor, clicking: true };
          t2 = setTimeout(() => (cursor = { ...cursor, clicking: false }), 320);
        }, 420);
      }
    });
    return () => {
      cancelled = true;
      if (t1) clearTimeout(t1);
      if (t2) clearTimeout(t2);
    };
  });

  /* ---- Callout placement ---- */
  type Side = 'right' | 'left' | 'below';
  let callout = $state<{ x: number; y: number; side: Side } | null>(null);
  const CALLOUT_W = 180;

  $effect(() => {
    // Depend on the whole state so we re-measure after each beat.
    void mock;
    const target = calloutTarget;
    let cancelled = false;
    // Measure again once outro transitions are done: a closing modal still holds its target until then.
    let again: ReturnType<typeof setTimeout> | undefined;
    tick().then(() => {
      place();
      if (!cancelled && dur > 0) again = setTimeout(place, dur + 60);
    });
    function place() {
      if (cancelled) return;
      if (!target) {
        callout = null;
        onFocus?.(null);
        return;
      }
      const [name, prefer = 'right'] = target.split(':') as [string, Side];
      const r = measure(name);
      if (!r) {
        callout = null;
        onFocus?.(null);
        return;
      }
      onFocus?.(r);
      let side: Side = prefer;
      let x: number;
      let y: number;
      if (side === 'right' && r.x + r.w + 14 + CALLOUT_W > DESIGN_W - 8) side = 'left';
      if (side === 'left' && r.x - 14 - CALLOUT_W < 8) side = 'below';
      if (side === 'right') {
        x = r.x + r.w + 14;
        y = r.y + r.h / 2 - 22;
      } else if (side === 'left') {
        x = r.x - 14 - CALLOUT_W;
        y = r.y + r.h / 2 - 22;
      } else {
        x = r.x;
        y = r.y + r.h + 12;
      }
      x = Math.max(8, Math.min(DESIGN_W - CALLOUT_W - 8, x));
      y = Math.max(8, Math.min(DESIGN_H - 64, y));
      callout = { x, y, side };
    }
    return () => {
      cancelled = true;
      if (again) clearTimeout(again);
    };
  });

  function botName(id: BotId): string {
    return t.bots[id].name;
  }

  const activeItems: TranscriptItem[] = $derived(
    mock.active === 'none' ? [] : mock.transcripts[mock.active]
  );

  /** More than one pane on screen: the conversation pane lays out like a phone and the current pane is framed. */
  const divided = $derived(!!mock.right);
  const narrow = $derived(divided);

  function focused(pane: PaneId): boolean {
    return divided && mock.focus === pane;
  }

  const chatTab = $derived(
    mock.active === 'coordinator' ? botName('coordinator') : mock.active === 'research' ? t.script.groupName : null
  );

  /** The flow board zooms out to fit when its pane gets short. */
  const boardScale = $derived(mock.bottom ? 0.7 : mock.flow.coordinator ? 0.86 : 1);

  const runningTurns: BotId[] = $derived.by(() => {
    const out: BotId[] = [];
    for (const item of mock.transcripts.research) {
      if (item.kind === 'replying') out.push(...item.bots);
      if (item.kind === 'bot' && item.streaming) out.push(item.bot);
    }
    return out;
  });

  const commandSummary = $derived(`${t.script.command} · exit 0 · ${t.script.commandTook}`);
  const noteParts = $derived(t.script.researcherNotePath.split('/'));
</script>

{#snippet flowIcon(size: number)}
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="8" y="2" width="8" height="6" rx="1.5"></rect><path d="M12 8v3"></path><path d="M5.5 14v-3h13v3"></path><rect x="2" y="14" width="7" height="6" rx="1.5"></rect><rect x="15" y="14" width="7" height="6" rx="1.5"></rect></svg>
{/snippet}

{#snippet gearIcon(size: number)}
  <svg viewBox="0 0 16 16" width={size} height={size}><circle cx="8" cy="8" r="2.2" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M8 1.8v1.6M8 12.6v1.6M1.8 8h1.6M12.6 8h1.6M3.6 3.6l1.1 1.1M11.3 11.3l1.1 1.1M3.6 12.4l1.1-1.1M11.3 4.7l1.1-1.1" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>
{/snippet}

{#snippet pinIcon(size: number)}
  <svg viewBox="0 0 16 16" width={size} height={size} fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"><path d="M6 2.5h4l-.6 4 2.1 2H4.5l2.1-2z"/><path d="M8 8.5V14" stroke-linecap="round"/></svg>
{/snippet}

{#snippet termIcon(size: number)}
  <svg viewBox="0 0 16 16" width={size} height={size} fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><rect x="1.5" y="3" width="13" height="10" rx="2"/><path d="M4.5 6.5 6.5 8l-2 1.5M8 10h3.5"/></svg>
{/snippet}

{#snippet folderIcon(size: number)}
  <svg viewBox="0 0 16 16" width={size} height={size}><path d="M1.5 4.5A1.5 1.5 0 0 1 3 3h3.2l1.3 1.5H13A1.5 1.5 0 0 1 14.5 6v6A1.5 1.5 0 0 1 13 13.5H3A1.5 1.5 0 0 1 1.5 12z" fill="none" stroke="currentColor" stroke-width="1.4"/></svg>
{/snippet}

{#snippet calendarIcon(size: number)}
  <svg viewBox="0 0 16 16" width={size} height={size} fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"><rect x="2.5" y="3.5" width="11" height="10" rx="2"/><path d="M2.5 6.8h11M5.5 2v3M10.5 2v3"/></svg>
{/snippet}

{#snippet fileIcon(size: number)}
  <svg viewBox="0 0 16 16" width={size} height={size}><path d="M4 1.5h5.5L13 5v9.5H4z" fill="none" stroke="currentColor" stroke-width="1.3"/><path d="M9.5 1.5V5H13" fill="none" stroke="currentColor" stroke-width="1.3"/></svg>
{/snippet}

{#snippet groupGlyph(size: number)}
  <svg viewBox="0 0 16 16" width={size} height={size}><circle cx="5.5" cy="6" r="2.4" fill="currentColor"/><circle cx="10.8" cy="6" r="2.4" fill="currentColor" opacity=".7"/><path d="M1.5 13c.5-2.4 2.2-3.6 4-3.6s3.5 1.2 4 3.6" fill="currentColor"/><path d="M8.6 13c.4-2 1.6-3.2 3.2-3.2 1.4 0 2.4 1 2.7 3.2" fill="currentColor" opacity=".7"/></svg>
{/snippet}

{#snippet commandRow()}
  {#if mock.command}
    <div class="cmd" class:running={mock.command.running} data-hit="cmd-row" in:fade={{ duration: dur }}>
      <div class="cmd-line">
        <span class="cmd-caret" class:open={mock.command.running}>▸</span>
        <span class="mono cmd-text">{mock.command.running ? t.script.command : commandSummary}</span>
        {#if mock.command.running}<span class="cmd-pulse"></span>{/if}
      </div>
      {#if mock.command.running}
        <div class="cmd-out mono">
          {#each t.script.commandOutput.slice(0, mock.command.lines) as line, i (i)}
            <div in:fade={{ duration: dur }}>{line}</div>
          {/each}
        </div>
      {/if}
    </div>
  {/if}
{/snippet}

{#snippet routeLine(bot: BotId, hit: boolean, open: boolean)}
  {@const r = t.script.routes[bot]}
  <span class="c-route" data-hit={hit ? 'route-line' : undefined}>
    <span class="cmd-caret" class:open>▸</span>
    <span class="mono c-model">{r.model}</span>
    <span>· {t.mock.thinking} {r.thinking} · {r.kind}</span>
  </span>
{/snippet}

<div class="win" bind:this={winEl} style:width="{DESIGN_W}px" style:height="{DESIGN_H}px" aria-hidden="true">
  <div class="frame" class:hidden-to-tray={!!mock.tray}>
    <!-- ───────── Sidebar ───────── -->
    <aside class="side">
      <div class="lights">
        <span class="light red" data-hit="window-close"></span>
        <span class="light yellow"></span>
        <span class="light green"></span>
      </div>

      <div class="roster-head" data-hit="roster-row">
        <span class="side-label">{t.mock.roster}</span>
        <button class="plus" data-hit="roster-add" title={t.mock.addBot} tabindex="-1">+</button>
      </div>
      <div class="roster">
        {#each mock.roster as bot (bot)}
          <div class="roster-item" in:scale={{ duration: dur, start: 0.4 }}>
            <Avatar name={botName(bot)} size={28} />
          </div>
        {/each}
        {#if mock.roster.length === 0}
          <span class="roster-empty"></span>
        {/if}
      </div>

      <div class="search">
        <svg viewBox="0 0 16 16" width="12" height="12"><circle cx="7" cy="7" r="4.5" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M10.5 10.5 14 14" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>
        <span>{t.mock.search}</span>
      </div>

      <div class="sessions">
        {#if mock.groups.length > 0}
          <div class="sect" in:fade={{ duration: dur }}>
            <div class="sect-head">{t.mock.groups}</div>
            {#each mock.groups as g (g.id)}
              <div
                class="row"
                class:active={mock.active === 'research'}
                data-hit="group-research"
                in:fly={{ x: -8, duration: dur }}
              >
                <span class="group-glyph">{@render groupGlyph(14)}</span>
                <span class="row-name">{g.name}</span>
                {#if g.pending}
                  <span class="badge-pending" in:scale={{ duration: dur }}>{t.mock.pendingApproval}</span>
                {/if}
              </div>
            {/each}
          </div>
        {/if}

        {#if mock.youBot.length > 0}
          <div class="sect" in:fade={{ duration: dur }}>
            <div class="sect-head">{t.mock.youBot}</div>
            {#each mock.youBot as bot (bot)}
              <div class="row" class:active={mock.active === bot} in:fly={{ x: -8, duration: dur }}>
                <Avatar name={botName(bot)} size={20} />
                <span class="row-name">{botName(bot)}</span>
              </div>
            {/each}
          </div>
        {/if}
      </div>

      <div class="side-foot">
        <span class="foot-icon" title={t.mock.workspace}>{@render folderIcon(13)}</span>
        <span class="foot-icon">{@render calendarIcon(13)}</span>
        <span class="foot-spacer"></span>
        <span class="foot-icon" class:lit={!!mock.terminal}>{@render termIcon(13)}</span>
        <span class="foot-icon" title={t.mock.settings}>{@render gearIcon(13)}</span>
      </div>
    </aside>

    <!-- ───────── Workbench ───────── -->
    <section class="bench">
      <!-- Conversation pane -->
      <div class="pane chat-pane" class:narrow class:focused={focused('chat')}>
        <div class="strip">
          {#if chatTab}
            <span class="tab on"><span class="tab-name">{chatTab}</span><span class="tab-x">×</span></span>
          {/if}
          <span class="tab-plus">+</span>
        </div>
        <div class="chat">
          <header class="top">
            {#if mock.active === 'coordinator'}
              <div class="top-id" in:fade={{ duration: dur }}>
                <Avatar name={botName('coordinator')} size={24} />
                <div class="top-text">
                  <span class="top-name">{botName('coordinator')}</span>
                  <span class="top-sub">{t.bots.coordinator.duties}</span>
                </div>
              </div>
              <div class="top-actions">
                <span class="ghost">{@render flowIcon(11)}{t.mock.trace}</span>
                <span class="ghost">{@render gearIcon(11)}{t.mock.botSettings}</span>
              </div>
            {:else if mock.active === 'research'}
              <div class="top-id" in:fade={{ duration: dur }}>
                <span class="group-glyph big">{@render groupGlyph(16)}</span>
                <div class="top-text">
                  <span class="top-name">{t.script.groupName}</span>
                  <span class="top-sub">{t.mock.members(4)}</span>
                </div>
                {#if !narrow}
                  <div class="stack">
                    {#each mock.roster as bot (bot)}
                      <span class="stack-item"><Avatar name={botName(bot)} size={18} /></span>
                    {/each}
                  </div>
                {/if}
              </div>
              {#if narrow}
                <span class="icon-btn" class:on={mock.chatMenu} data-hit="chat-more" title={t.mock.more}>
                  <svg viewBox="0 0 16 16" width="14" height="14"><circle cx="3.5" cy="8" r="1.3" fill="currentColor"/><circle cx="8" cy="8" r="1.3" fill="currentColor"/><circle cx="12.5" cy="8" r="1.3" fill="currentColor"/></svg>
                </span>
              {:else}
                <div class="top-actions">
                  <span class="ghost">{@render pinIcon(11)}{t.mock.pin}</span>
                  <span class="ghost">{@render flowIcon(11)}{t.mock.trace}</span>
                  <span class="ghost">{@render gearIcon(11)}{t.mock.groupSettings}</span>
                </div>
              {/if}
            {:else}
              <div class="top-id">
                <span class="top-name muted">{t.mock.windowTitle}</span>
              </div>
            {/if}
          </header>

          <div class="body">
            {#if !narrow && activeItems.length > 1}
              <div class="msg-index" in:fade={{ duration: dur }}>
                {#each activeItems.filter((i) => i.kind !== 'replying') as item (item.id)}
                  <i class:you={item.kind === 'user'} class:ask={item.kind === 'approval'}></i>
                {/each}
              </div>
            {/if}
            <div class="transcript">
              {#if mock.active === 'none'}
                {#if mock.wizardComplete}
                  <p class="empty" in:fade={{ duration: dur }}>{t.mock.emptyRoster}</p>
                {/if}
              {:else if activeItems.length === 0 && mock.active === 'coordinator'}
                <div class="welcome" in:fade={{ duration: dur }}>
                  <Avatar name={botName('coordinator')} size={40} />
                  <p class="welcome-title">{t.mock.welcome}</p>
                  <div class="starters">
                    {#each t.mock.starters as s}
                      <span class="starter">{s}</span>
                    {/each}
                  </div>
                </div>
              {:else}
                <div class="items">
                  {#each activeItems as item (item.id)}
                    {#if item.kind === 'user'}
                      <div class="msg you" in:fly={{ y: 10, duration: dur }}>
                        <div class="bubble you" data-hit="msg-{item.id}">{item.text}</div>
                        <span class="time">{item.time}</span>
                      </div>
                      {#if mock.judgement && item.id === 'g1'}
                        <div class="judgement" data-hit="judgement" in:fly={{ y: 6, duration: dur }}>
                          <span class="j-label">{t.mock.judgementLabel}</span>
                          <span class="j-chip join"><Avatar name={botName('researcher')} size={14} />{botName('researcher')} · {t.mock.judgementJoin}</span>
                          <span class="j-chip"><Avatar name={botName('writer')} size={14} />{botName('writer')} · {t.mock.judgementPass}</span>
                          <span class="j-chip"><Avatar name={botName('coordinator')} size={14} />{botName('coordinator')} · {t.mock.judgementPass}</span>
                        </div>
                      {/if}
                    {:else if item.kind === 'bot'}
                      <div class="msg bot" in:fly={{ y: 10, duration: dur }}>
                        <Avatar name={botName(item.bot)} size={26} />
                        <div class="msg-col">
                          <div class="meta">
                            <span class="who">{botName(item.bot)}</span>
                            {#if mock.active === 'research' && !narrow}
                              <span class="model-pill mono">{t.script.routes[item.bot].model}</span>
                            {/if}
                            <span class="time">{item.time}</span>
                          </div>
                          <div class="bubble bot" data-hit="msg-{item.id}">
                            {#if item.streaming}
                              <Typewriter text={item.parts.map((p) => (p.type === 'text' ? p.text : '')).join('')} duration={2600} {instant} caret />
                            {:else}
                              {#each item.parts as part}
                                {#if part.type === 'text'}
                                  <span>{part.text}</span>
                                {:else}
                                  <span class="mention" data-hit="mention-{part.bot}"><Avatar name={botName(part.bot)} size={13} />@{botName(part.bot)}</span>
                                {/if}
                              {/each}
                            {/if}
                          </div>
                          {#if item.id === 'g3'}{@render commandRow()}{/if}
                          {#if item.artifacts}
                            <div class="artifacts">
                              {#each item.artifacts as path}
                                <span class="artifact" data-hit={path === t.script.reportPath ? 'artifact-report' : 'artifact-note'}>
                                  {@render fileIcon(12)}
                                  <span class="mono">{path}</span>
                                </span>
                              {/each}
                            </div>
                          {/if}
                        </div>
                      </div>
                    {:else if item.kind === 'replying'}
                      <div class="replying" in:fade={{ duration: dur }}>
                        {#each item.bots as b}
                          <span class="rep"><Avatar name={botName(b)} size={16} /><span>{botName(b)}</span><span class="rep-label">{t.mock.replying}</span><span class="dots"><i></i><i></i><i></i></span></span>
                        {/each}
                      </div>
                      {#if item.id === 'gr3' && mock.command?.running}
                        <div class="cmd-under">{@render commandRow()}</div>
                      {/if}
                    {:else if item.kind === 'approval'}
                      <div class="approval" data-hit="approval-card" class:allowed={item.status === 'allowed'} in:fly={{ y: 10, duration: dur }}>
                        <div class="ap-head">
                          <Avatar name={botName(item.bot)} size={18} />
                          <span class="ap-title">{t.mock.approvalTitle(botName(item.bot))}</span>
                          <span class="time">{item.time}</span>
                        </div>
                        <dl class="ap-rows">
                          <dt>{t.mock.approvalKind}</dt><dd>{t.mock.approvalKindValue}</dd>
                          <dt>{t.mock.approvalName}</dt><dd class="mono">fetch</dd>
                          <dt>{t.mock.approvalTransport}</dt><dd class="mono">stdio</dd>
                          <dt>{t.mock.approvalCommand}</dt><dd class="mono">npx -y @modelcontextprotocol/server-fetch</dd>
                        </dl>
                        <div class="ap-foot">
                          {#if item.status === 'pending'}
                            <span class="ap-note">{t.mock.approvalNoAlways}</span>
                            <button class="ap-btn primary" data-hit="allow-once" tabindex="-1">{t.mock.allowOnce}</button>
                            <button class="ap-btn" tabindex="-1">{t.mock.deny}</button>
                          {:else}
                            <span class="ap-note">{t.mock.approvalNoAlways}</span>
                            <span class="ap-status" in:scale={{ duration: dur }}>{t.mock.allowed} · 14:27</span>
                          {/if}
                        </div>
                      </div>
                    {/if}
                  {/each}
                </div>
              {/if}
            </div>
          </div>

          <footer class="composer">
            <div class="composer-card">
              <div class="composer-text" class:placeholder={!mock.composer}>
                {#if mock.composer}
                  <Typewriter text={mock.composer.text} duration={2000} {instant} caret />
                {:else}
                  {t.mock.composerPlaceholder}
                {/if}
              </div>
              <div class="composer-bar">
                <span class="attach">
                  <svg viewBox="0 0 16 16" width="14" height="14"><path d="M10.5 4.5 6 9a1.6 1.6 0 0 0 2.3 2.3l4.4-4.4a3 3 0 0 0-4.3-4.3L3.6 7.4a4.2 4.2 0 0 0 6 6L13 10" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>
                </span>
                <span class="send" class:ready={!!mock.composer}>
                  <svg viewBox="0 0 16 16" width="12" height="12"><path d="M8 13V3M3.5 7.5 8 3l4.5 4.5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>
                </span>
              </div>
            </div>
            {#if !narrow}<div class="composer-hint">{t.mock.sendHint}</div>{/if}
          </footer>
        </div>

        {#if mock.chatMenu}
          <div class="menu chat-menu" in:fly={{ y: -4, duration: dur }}>
            <span class="menu-item">{@render pinIcon(12)}{t.mock.pin}</span>
            <span class="menu-item" data-hit="menu-trace">{@render flowIcon(12)}{t.mock.trace}</span>
            <span class="menu-item">{@render gearIcon(12)}{t.mock.groupSettings}</span>
          </div>
        {/if}
      </div>

      {#if mock.right}
        <div class="col-right" in:fly={{ x: 40, duration: dur }}>
          <!-- Preview and flow share one pane, one tab each -->
          <div class="pane right-pane" class:short={!!mock.bottom} class:focused={focused('right')}>
            <div class="strip">
              {#each mock.right.tabs as tab (tab)}
                <span class="tab" class:on={mock.right.active === tab} in:fade={{ duration: dur }}>
                  {#if tab === 'flow'}<span class="tab-icon">{@render flowIcon(10)}</span>{/if}
                  <span class="tab-name">{tab === 'preview' ? t.mock.artifactsOf(t.script.groupName) : t.mock.flowOf(t.script.groupName)}</span>
                  <span class="tab-x">×</span>
                </span>
              {/each}
              <span class="tab-plus">+</span>
            </div>

            {#if mock.right.active === 'preview' && mock.preview}
              <div class="pv">
                <div class="pv-tree">
                  <span class="tr-row">{@render fileIcon(11)}<span>{t.script.briefPath}</span></span>
                  <span class="tr-row">{@render folderIcon(11)}<span>{noteParts[0]}/</span></span>
                  <span class="tr-row sub">{@render fileIcon(11)}<span>{noteParts[1]}</span></span>
                  <span class="tr-row on">{@render fileIcon(11)}<span>{t.script.reportPath}</span></span>
                </div>
                <div class="pv-editor">
                  <span class="pv-toggle"><span>{t.mock.previewRendered}</span><span class="on">{t.mock.previewSource}</span></span>
                  <div class="pv-body">
                    {#each t.script.reportLines as line, i}
                      <div class="code-line">
                        <span class="ln">{i + 1}</span>
                        <span class="code" class:h={line.startsWith('#')} class:q={line.startsWith('>')}>{line}</span>
                      </div>
                    {/each}
                    {#if mock.preview.edited}
                      <div class="code-line edit" data-hit="pv-edit">
                        <span class="ln">{t.script.reportLines.length + 1}</span>
                        <span class="code q"><Typewriter text={t.script.reportEditLine} duration={900} {instant} caret={!mock.preview.saved} /></span>
                      </div>
                    {/if}
                  </div>
                  {#if mock.preview.saved}
                    <div class="pv-toast" in:fly={{ y: 8, duration: dur }}>{t.mock.previewSaved} · ⌘S</div>
                  {/if}
                </div>
              </div>
            {:else if mock.right.active === 'flow'}
              <div class="flow" in:fade={{ duration: dur }}>
                <div class="fl-bar">
                  <span class="fl-job">{@render flowIcon(11)}<span class="fl-job-title">{t.script.jobTitle}</span><svg class="fl-chev" viewBox="0 0 16 16" width="9" height="9"><path d="M4 6l4 4 4-4" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg></span>
                  <span class="fl-toggle">{t.mock.flowFeedback}<b>0</b></span>
                  <span class="fl-toggle">{t.mock.flowBlamed}<b>0</b></span>
                </div>
                <div class="fl-canvas">
                  <div class="fl-board" style:transform="translateX(-50%) scale({boardScale})">
                    <div class="card">
                      <div class="c-head"><Avatar name={t.mock.you} size={16} /><span class="c-name">{t.mock.you}</span><span class="time">14:24</span></div>
                      <p class="c-text">{t.script.userGroupGoal}</p>
                      <span class="c-meta">{t.mock.flowWatched(2)}</span>
                    </div>
                    <span class="link"></span>
                    <div class="card">
                      <div class="c-head"><Avatar name={botName('researcher')} size={16} /><span class="c-name">{botName('researcher')}</span><span class="c-status done">{t.mock.flowDone}</span></div>
                      <p class="c-text">{t.script.researcherHandoff[0]}</p>
                      <div class="c-files"><span class="artifact">{@render fileIcon(11)}<span class="mono">{t.script.researcherNotePath}</span></span></div>
                      {@render routeLine('researcher', true, mock.flow.unfolded)}
                      {#if mock.flow.unfolded}
                        <div class="c-detail" in:fly={{ y: -4, duration: dur }}>
                          <span class="lbl">{t.mock.flowWhy}</span>
                          <p>{t.script.routes.researcher.reason}</p>
                          <span class="exec">{t.script.routes.researcher.exec}</span>
                        </div>
                      {/if}
                    </div>
                    <span class="link"></span>
                    <div class="card">
                      <div class="c-head"><Avatar name={botName('writer')} size={16} /><span class="c-name">{botName('writer')}</span><span class="c-status done">{t.mock.flowDone}</span></div>
                      <p class="c-text">{t.script.writerDone}</p>
                      <div class="c-files"><span class="artifact">{@render fileIcon(11)}<span class="mono">{t.script.reportPath}</span></span></div>
                      {@render routeLine('writer', false, false)}
                    </div>
                    {#if mock.flow.coordinator}
                      <span class="link" in:fade={{ duration: dur }}></span>
                      <div class="card running" in:fly={{ y: 8, duration: dur }}>
                        <div class="c-head"><Avatar name={botName('coordinator')} size={16} /><span class="c-name">{botName('coordinator')}</span><span class="c-status running">{t.mock.flowRunning}</span></div>
                        <p class="c-text">{t.script.coordinatorClose}</p>
                        {@render routeLine('coordinator', false, false)}
                      </div>
                    {/if}
                  </div>
                </div>
              </div>
            {/if}

            <span class="rc-anchor" data-hit="rc-point"></span>
            {#if mock.splitMenu}
              <div class="menu split-menu" in:scale={{ duration: dur, start: 0.94 }}>
                {#each t.mock.split as label, i}
                  <span class="menu-item" data-hit={i === 1 ? 'split-down' : undefined}>{label}</span>
                {/each}
              </div>
            {/if}
          </div>

          {#if mock.bottom}
            <div class="pane bottom-pane" class:focused={focused('bottom')} in:fly={{ y: 30, duration: dur }}>
              <div class="strip">
                {#if mock.bottom === 'terminal'}
                  <span class="tab on" in:fade={{ duration: dur }}><span class="tab-icon">{@render termIcon(10)}</span><span class="tab-name">{t.script.terminalFolder}</span><span class="tab-x">×</span></span>
                {/if}
                <span class="tab-plus">+</span>
              </div>
              {#if mock.bottom === 'empty'}
                <div class="empty-pane" in:fade={{ duration: dur }}>
                  <p class="ep-title">{t.mock.emptyTitle}</p>
                  <p class="ep-hint">{t.mock.emptyHint}</p>
                  <div class="ep-list">
                    <span class="ep-filter">
                      <svg viewBox="0 0 16 16" width="11" height="11"><circle cx="7" cy="7" r="4.5" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M10.5 10.5 14 14" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>
                      {t.mock.emptyFilter}
                    </span>
                    <span class="ep-row" data-hit="empty-new-terminal">{@render termIcon(12)}{t.mock.emptyItems[0]}</span>
                    <span class="ep-row">{@render folderIcon(12)}{t.mock.emptyItems[1]}</span>
                    <span class="ep-row">{@render calendarIcon(12)}{t.mock.emptyItems[2]}</span>
                    <span class="ep-sect">{t.mock.emptyReattach}</span>
                    <span class="ep-none">{t.mock.emptyNoReattach}</span>
                  </div>
                </div>
              {:else if mock.terminal}
                <div class="term" in:fade={{ duration: dur }}>
                  <div class="term-head">
                    <span class="mono term-path">~/{t.script.terminalFolder}</span>
                    <span class="t-btn">{t.mock.terminalStop}</span>
                    <span class="t-btn">{t.mock.terminalEnd}</span>
                  </div>
                  <div class="term-body mono" data-hit="term-output">
                    <div><span class="t-cwd">~/{t.script.terminalFolder}</span> <span class="t-prompt">❯</span> <Typewriter text={t.script.terminalCommand} duration={500} {instant} caret={mock.terminal.lines === 0} /></div>
                    {#each t.script.terminalOutput.slice(0, mock.terminal.lines) as line, i (i)}
                      <div class:t-dim={line.startsWith('>')} class:t-ok={line.includes('VITE')} class:t-link={line.includes('➜')} in:fade={{ duration: dur }}>{line || ' '}</div>
                    {/each}
                  </div>
                </div>
              {/if}
            </div>
          {/if}
        </div>
      {/if}
    </section>

    <!-- ───────── Settings modal (wizard empty state) ───────── -->
    {#if mock.settings > 0}
      <div class="backdrop" transition:fade={{ duration: dur }}></div>
      <div class="modal" transition:scale={{ duration: dur, start: 0.96 }}>
        <div class="modal-head">
          <span class="modal-title">{t.mock.settingsTitle}</span>
          <span class="tabs">
            {#each t.mock.settingsTabs as tab, i}
              <span class="stab" class:on={i === 0}>{tab}</span>
            {/each}
          </span>
        </div>
        <p class="wizard-hint">{t.mock.wizardHint}</p>

        <div class="field">
          <span class="label">{t.mock.workspaceLabel}</span>
          <div class="input mono">
            {#if mock.settings >= 2}<Typewriter text={t.script.workspacePath} duration={700} {instant} caret />{/if}
          </div>
        </div>

        <div class="field two">
          <div>
            <span class="label">{t.mock.endpointLabel} · {t.mock.endpointName}</span>
            <div class="input">{#if mock.settings >= 3}<Typewriter text={t.script.endpointName} duration={350} {instant} />{/if}</div>
          </div>
          <div>
            <span class="label">{t.mock.endpointUrlLabel}</span>
            <div class="input mono">{#if mock.settings >= 3}<Typewriter text={t.script.endpointUrl} duration={700} {instant} caret />{/if}</div>
          </div>
        </div>

        <div class="field">
          <span class="label">{t.mock.endpointKeyLabel}</span>
          <div class="key-row" data-hit="settings-key">
            <div class="input mono key">{#if mock.settings >= 4}<span in:fade={{ duration: dur }}>••••••••••••••••••••••••</span>{/if}</div>
            {#if mock.settings >= 4}<span class="chip-ok" data-hit="settings-key-chip" in:scale={{ duration: dur }}>{t.mock.keySet}</span>{/if}
          </div>
          <span class="field-hint">{t.mock.keyHint}</span>
        </div>

        <div class="field">
          <span class="label">{t.mock.modelsLabel}</span>
          <div class="models">
            <div class="m-row head">
              <span></span><span>{t.mock.modelCols.strengths}</span><span>{t.mock.modelCols.thinking}</span><span>{t.mock.modelCols.price}</span>
            </div>
            {#if mock.settings >= 5}
              {#each t.script.models as m, i (m.name)}
                <div class="m-row" in:fly={{ y: 6, duration: dur, delay: instant ? 0 : i * 140 }}>
                  <span class="m-name-cell"><i class="m-dot" class:on={i === 0}></i><span class="mono m-name">{m.name}</span>{#if i === 0}<span class="m-default">{t.mock.defaultModel}</span>{/if}</span>
                  <span>{m.strengths}</span><span class="mono">{m.thinking}</span><span class="mono">{m.price}</span>
                </div>
              {/each}
            {/if}
          </div>
        </div>

        <div class="modal-foot">
          <button class="btn-dark" data-hit="settings-save" tabindex="-1">{t.mock.save}</button>
        </div>
      </div>
    {/if}

    <!-- ───────── New bot slide-out ───────── -->
    {#if mock.create > 0}
      <div class="sheet" transition:fly={{ x: -40, duration: dur }}>
        <div class="sheet-head">{t.mock.newBot}</div>
        <div class="avatar-row">
          <span class="avatar-frame">
            {#if mock.create >= 2}<span in:scale={{ duration: dur }}><Avatar name={t.bots.coordinator.name} size={44} /></span>{/if}
          </span>
          <div class="avatar-meta">
            <span class="label">{t.mock.fieldAvatar}</span>
            <span class="ghost small">{t.mock.avatarRefresh}</span>
          </div>
        </div>
        <div class="field">
          <span class="label">{t.mock.fieldName}</span>
          <div class="input">{#if mock.create >= 2}<Typewriter text={t.bots.coordinator.name} duration={500} {instant} caret />{/if}</div>
        </div>
        <div class="field">
          <span class="label">{t.mock.fieldDuties}</span>
          <div class="input tall">{#if mock.create >= 3}<Typewriter text={t.bots.coordinator.duties} duration={800} {instant} caret />{/if}</div>
        </div>
        <div class="field">
          <span class="label">{t.mock.fieldBoundaries}</span>
          <div class="input tall">{#if mock.create >= 4}<Typewriter text={t.bots.coordinator.boundaries} duration={900} {instant} caret />{/if}</div>
        </div>
        <div class="sheet-foot">
          <button class="btn-dark" data-hit="create-save" tabindex="-1">{t.mock.save}</button>
        </div>
      </div>
    {/if}
  </div>

  <!-- ───────── Tray (window hidden) ───────── -->
  {#if mock.tray}
    <div class="desk" transition:fade={{ duration: dur }}>
      <div class="menubar">
        <span class="apple"></span>
        <span class="mb-item strong">Finder</span>
        <span class="mb-item">File</span><span class="mb-item">Edit</span><span class="mb-item">View</span>
        <span class="mb-spacer"></span>
        <span class="tray-icon" class:open={mock.tray.menu}>
          <svg viewBox="0 0 16 16" width="14" height="14"><rect x="2" y="3" width="12" height="9" rx="2.5" fill="none" stroke="currentColor" stroke-width="1.5"/><circle cx="6" cy="7.5" r="1" fill="currentColor"/><circle cx="10" cy="7.5" r="1" fill="currentColor"/><path d="M8 1v2" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>
        </span>
        <span class="mb-item">14:36</span>
      </div>
      {#if mock.tray.menu}
        <div class="tray-menu" in:fly={{ y: -6, duration: dur }}>
          <span class="tm-item">{t.mock.trayShow}</span>
          <span class="tm-item">{t.mock.trayStop}</span>
          <span class="tm-sep"></span>
          <span class="tm-item">{t.mock.trayQuit} <kbd>⌘Q</kbd></span>
        </div>
      {/if}
      {#if mock.tray.banner}
        <div class="banner" data-hit="notif-banner" in:fly={{ x: 60, duration: instant ? 0 : 360 }}>
          <span class="bn-icon"><Logo size={30} /></span>
          <div class="bn-text">
            <div class="bn-top"><span class="bn-app">Real Bot</span><span class="bn-time">{t.mock.bannerNow}</span></div>
            <div class="bn-title">{t.script.groupName} · {botName('coordinator')}</div>
            <div class="bn-body">{t.script.coordinatorClose}</div>
          </div>
        </div>
      {/if}
      <div class="desk-status" data-hit="tray-status" in:fly={{ y: 8, duration: dur, delay: instant ? 0 : 200 }}>
        <p class="ds-title">{t.mock.trayHidden}</p>
        <div class="ds-turns">
          {#each runningTurns as b}
            <span class="rep"><Avatar name={botName(b)} size={18} /><span>{botName(b)}</span><span class="rep-label">{t.mock.trayTurns}</span><span class="dots"><i></i><i></i><i></i></span></span>
          {/each}
          {#if mock.terminal}
            <span class="rep term-rep">{@render termIcon(14)}<span class="mono">{t.mock.trayTerminal(t.script.terminalCommand)}</span></span>
          {/if}
        </div>
      </div>
      <div class="dock">
        <span class="dk-app a"></span>
        <span class="dk-app b"></span>
        <span class="dk-app c"></span>
        <span class="dk-app rb">
          <Logo size={34} />
          {#if mock.tray.banner}<span class="dk-badge" in:scale={{ duration: dur, start: 0.3 }}>1</span>{/if}
          <i class="dk-dot"></i>
        </span>
      </div>
    </div>
  {/if}

  <!-- ───────── Callout ───────── -->
  {#if callout && calloutText}
    <div class="callout {callout.side}" style:left="{callout.x}px" style:top="{callout.y}px" style:width="{CALLOUT_W}px" in:fade={{ duration: dur }}>
      {calloutText}
    </div>
  {/if}

  <!-- ───────── Cursor ───────── -->
  <div
    class="cursor"
    class:visible={cursor.visible}
    class:clicking={cursor.clicking}
    style:transform="translate({cursor.x}px, {cursor.y}px)"
  >
    <svg viewBox="0 0 24 24" width="22" height="22"><path d="M5 3l14 8.5-6.2 1.6L9.5 20z" stroke-width="1.6" stroke-linejoin="round"/></svg>
    <span class="ripple"></span>
  </div>
</div>

<style>
  /* Window-local tokens: the messenger's own palette, light or dark with the page. */
  .win {
    --bg: var(--app-bg);
    --pane: var(--app-pane);
    --sidebar: var(--app-sidebar);
    --ink: var(--app-ink);
    --ink-2: var(--app-ink-2);
    --muted: var(--app-muted);
    --muted-2: var(--app-muted-2);
    --line: var(--app-line);
    --line-2: var(--app-line-2);
    --accent: var(--app-accent);
    --accent-tint: var(--app-accent-tint);
    --accent-line: var(--app-accent-line);
    --bot-bubble: var(--app-bot-bubble);
    --card: var(--app-card);
    --card-line: var(--app-card-line);
    --card-ink: var(--app-card-ink);
    --ok-bg: var(--app-ok-bg);
    --ok-line: var(--app-ok-line);
    --ok-text: var(--app-ok-text);
    --warn-bg: var(--app-warn-bg);
    --warn-text: var(--app-warn-text);
    --glass: var(--app-glass);
    --on-ink: var(--app-on-ink);
    --shadow: var(--app-shadow);
    --font: -apple-system, BlinkMacSystemFont, "SF Pro Text", "PingFang SC", "Hiragino Sans GB", "Noto Sans SC", system-ui, sans-serif;
    --mono: "SF Mono", Menlo, Monaco, Consolas, ui-monospace, monospace;

    position: relative;
    font-family: var(--font);
    font-size: 12.5px;
    line-height: 1.5;
    color: var(--ink);
    background: var(--bg);
    border-radius: 12px;
    overflow: hidden;
    box-shadow: 0 0 0 1px var(--line);
    user-select: none;
  }

  .mono { font-family: var(--mono); }
  kbd {
    font-family: var(--font);
    font-size: 10px;
    color: var(--muted);
    border: 1px solid var(--line);
    border-radius: 4px;
    padding: 0 4px;
    line-height: 1.5;
    background: var(--pane);
  }
  button { font: inherit; color: inherit; background: none; border: 0; padding: 0; cursor: default; }

  .frame {
    position: absolute;
    inset: 0;
    display: grid;
    grid-template-columns: 200px 1fr;
    transition: transform 420ms cubic-bezier(0.2, 0.7, 0.2, 1), opacity 320ms ease;
    transform-origin: 50% 20%;
  }
  .frame.hidden-to-tray { transform: scale(0.9) translateY(24px); opacity: 0; pointer-events: none; }

  /* ── Sidebar ── */
  .side {
    background: var(--sidebar);
    border-right: 1px solid var(--line);
    display: flex;
    flex-direction: column;
    padding: 0 10px 10px;
    min-height: 0;
  }
  .lights { display: flex; gap: 8px; padding: 14px 4px 10px; }
  .light { width: 12px; height: 12px; border-radius: 50%; display: inline-block; }
  .light.red { background: #ff5f57; }
  .light.yellow { background: #febc2e; }
  .light.green { background: #28c840; }

  .side-label, .sect-head {
    font-size: 10.5px;
    font-weight: 600;
    color: var(--muted);
    letter-spacing: 0.02em;
  }
  .roster-head { display: flex; align-items: center; justify-content: space-between; padding: 6px 4px 6px; }
  .plus {
    width: 20px; height: 20px; border-radius: 6px;
    border: 1px solid var(--line); background: var(--pane);
    color: var(--ink-2); font-size: 14px; line-height: 1;
    display: inline-flex; align-items: center; justify-content: center;
  }
  .roster { display: flex; gap: 6px; align-items: center; padding: 0 4px 10px; min-height: 38px; border-bottom: 1px solid var(--line); }
  .roster-item { display: inline-flex; box-shadow: 0 0 0 2px var(--pane); border-radius: 50%; }
  .roster-empty { width: 28px; height: 28px; border-radius: 50%; border: 1px dashed var(--line); }

  .search {
    margin: 10px 0 8px;
    display: flex; align-items: center; gap: 6px;
    padding: 5px 8px; border-radius: 7px;
    background: var(--pane); border: 1px solid var(--line);
    color: var(--muted-2); font-size: 11px;
    white-space: nowrap; overflow: hidden;
  }
  .search span { overflow: hidden; text-overflow: ellipsis; }

  .sessions { flex: 1; min-height: 0; overflow: hidden; }
  .sect { margin-top: 6px; }
  .sect-head { padding: 6px 4px 4px; }
  .row {
    display: flex; align-items: center; gap: 8px;
    padding: 6px 8px; border-radius: 8px;
    color: var(--ink-2); font-size: 12px;
    position: relative;
  }
  .row.active { background: var(--pane); color: var(--ink); font-weight: 600; box-shadow: 0 1px 2px var(--shadow); }
  .row-name { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .group-glyph { width: 20px; height: 20px; border-radius: 6px; background: var(--accent-tint); color: var(--accent); display: inline-flex; align-items: center; justify-content: center; flex: none; }
  .group-glyph.big { width: 24px; height: 24px; border-radius: 7px; }
  .badge-pending {
    font-size: 10px; font-weight: 600; color: var(--warn-text);
    background: var(--warn-bg); border: 1px solid var(--card-line);
    border-radius: 999px; padding: 0 6px; line-height: 1.6;
  }

  .side-foot { display: flex; align-items: center; gap: 4px; padding-top: 10px; border-top: 1px solid var(--line); }
  .foot-spacer { flex: 1; }
  .foot-icon {
    width: 26px; height: 24px; border-radius: 7px;
    display: inline-flex; align-items: center; justify-content: center;
    color: var(--muted);
  }
  .foot-icon.lit { color: var(--accent); background: var(--accent-tint); }

  /* ── Workbench ── */
  .bench { display: flex; gap: 4px; min-width: 0; min-height: 0; background: var(--bg); }
  .pane {
    position: relative;
    display: flex; flex-direction: column;
    min-width: 0; min-height: 0;
    background: var(--pane);
    overflow: hidden;
  }
  .pane.focused::after {
    content: ''; position: absolute; inset: 0; z-index: 4; pointer-events: none;
    border: 1.5px solid var(--accent); border-radius: 3px;
  }
  .chat-pane { flex: 1 1 auto; }
  .col-right { width: 360px; flex: none; display: flex; flex-direction: column; gap: 4px; min-height: 0; }
  .right-pane { flex: 1 1 auto; }
  .right-pane.short { flex: 0 0 292px; }
  .bottom-pane { flex: 1 1 auto; }

  /* Tab strip, the browser kind */
  .strip {
    height: 30px; flex: none;
    display: flex; align-items: flex-end; gap: 2px;
    padding: 0 8px;
    background: var(--bg);
  }
  .tab {
    display: inline-flex; align-items: center; gap: 6px;
    height: 25px; max-width: 170px; min-width: 0;
    padding: 0 8px 0 10px;
    border-radius: 8px 8px 0 0;
    font-size: 11px; color: var(--muted);
    white-space: nowrap;
  }
  .tab.on { background: var(--pane); color: var(--ink); font-weight: 500; }
  .tab-name { overflow: hidden; text-overflow: ellipsis; min-width: 0; }
  .tab-icon { display: inline-flex; color: var(--muted); flex: none; }
  .tab-x { font-size: 11px; color: var(--muted-2); line-height: 1; flex: none; }
  .tab-plus { height: 25px; width: 22px; display: inline-flex; align-items: center; justify-content: center; color: var(--muted); font-size: 14px; flex: none; }

  /* ── Conversation ── */
  .chat { flex: 1; display: grid; grid-template-rows: 44px 1fr auto; min-height: 0; }
  .top {
    display: flex; align-items: center; justify-content: space-between; gap: 8px;
    padding: 0 14px; border-bottom: 1px solid var(--line);
    background: var(--glass);
  }
  .top-id { display: flex; align-items: center; gap: 10px; min-width: 0; }
  .top-text { display: flex; flex-direction: column; line-height: 1.2; min-width: 0; }
  .top-name { font-weight: 600; font-size: 13px; }
  .top-name.muted { color: var(--muted); font-weight: 500; }
  .top-sub { font-size: 10.5px; color: var(--muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 260px; }
  .stack { display: flex; margin-left: 6px; }
  .stack-item { display: inline-flex; margin-left: -6px; border-radius: 50%; box-shadow: 0 0 0 2px var(--pane); }
  .top-actions { display: flex; gap: 6px; flex: none; }
  .ghost {
    display: inline-flex; align-items: center; gap: 5px;
    font-size: 11px; color: var(--ink-2); padding: 4px 8px;
    border-radius: 7px; border: 1px solid var(--line); background: var(--pane);
    white-space: nowrap;
  }
  .ghost :global(svg) { color: var(--muted); }
  .ghost.small { font-size: 11px; padding: 3px 8px; display: inline-block; }
  .icon-btn {
    width: 28px; height: 26px; border-radius: 7px; flex: none;
    display: inline-flex; align-items: center; justify-content: center;
    border: 1px solid var(--line); color: var(--ink-2); background: var(--pane);
  }
  .icon-btn.on { background: var(--sidebar); }

  .body { position: relative; min-height: 0; display: flex; overflow: hidden; }
  .transcript {
    flex: 1; min-width: 0; min-height: 0;
    display: flex; flex-direction: column; justify-content: flex-end;
    padding: 14px 18px 8px 22px; overflow: hidden;
    -webkit-mask-image: linear-gradient(to bottom, transparent, #000 28px);
    mask-image: linear-gradient(to bottom, transparent, #000 28px);
  }
  .narrow .transcript { padding: 12px 12px 8px; }
  .items { display: flex; flex-direction: column; gap: 12px; }
  .empty { margin: auto; color: var(--muted); font-size: 12.5px; text-align: center; }

  /* Message index along the conversation's left edge (desktop, wide pane only) */
  .msg-index {
    position: absolute; left: 6px; top: 50%; transform: translateY(-50%); z-index: 1;
    display: flex; flex-direction: column; gap: 6px;
  }
  .msg-index i { display: block; width: 8px; height: 2px; border-radius: 1px; background: var(--line); }
  .msg-index i.you { background: var(--accent-line); }
  .msg-index i.ask { background: var(--card-line); }
  .msg-index i:last-child { width: 11px; background: var(--muted-2); }

  .welcome { margin: auto; display: flex; flex-direction: column; align-items: center; gap: 10px; text-align: center; }
  .welcome-title { margin: 0; font-weight: 600; font-size: 13.5px; }
  .starters { display: flex; flex-wrap: wrap; gap: 6px; justify-content: center; max-width: 380px; }
  .starter { font-size: 11.5px; color: var(--ink-2); border: 1px solid var(--line); border-radius: 999px; padding: 4px 10px; background: var(--sidebar); }

  .msg { display: flex; gap: 10px; align-items: flex-start; }
  .msg.you { flex-direction: column; align-items: flex-end; gap: 3px; }
  .msg-col { min-width: 0; display: flex; flex-direction: column; gap: 4px; }
  .meta { display: flex; align-items: baseline; gap: 8px; }
  .who { font-weight: 600; font-size: 12px; }
  .model-pill { font-size: 9.5px; color: var(--muted); border: 1px solid var(--line); border-radius: 5px; padding: 0 5px; line-height: 1.6; }
  .time { font-size: 10.5px; color: var(--muted-2); font-variant-numeric: tabular-nums; }
  .bubble { padding: 8px 12px; border-radius: 12px; max-width: 440px; font-size: 12.5px; line-height: 1.55; overflow-wrap: anywhere; }
  .narrow .bubble { max-width: 250px; font-size: 12px; }
  .bubble.you { background: var(--accent); color: #fff; border-bottom-right-radius: 4px; }
  .bubble.bot { background: var(--bot-bubble); border: 1px solid var(--line); border-top-left-radius: 4px; }

  .mention {
    display: inline-flex; align-items: center; gap: 4px; vertical-align: -3px;
    padding: 1px 7px 1px 3px; margin: 0 2px; border-radius: 999px;
    background: var(--accent-tint); color: var(--accent); font-weight: 600; font-size: 11.5px;
    border: 1px solid var(--accent-line);
  }
  .artifacts { display: flex; gap: 6px; flex-wrap: wrap; }
  .artifact {
    display: inline-flex; align-items: center; gap: 5px; min-width: 0;
    padding: 3px 9px 3px 7px; border-radius: 7px;
    border: 1px solid var(--line); background: var(--pane); color: var(--ink-2); font-size: 11px;
  }
  .artifact :global(svg) { color: var(--muted); flex: none; }
  .artifact .mono { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

  .replying { display: flex; gap: 14px; padding-left: 36px; }
  .rep { display: inline-flex; align-items: center; gap: 6px; font-size: 11.5px; color: var(--ink-2); }
  .rep-label { color: var(--muted); }
  .dots { display: inline-flex; gap: 3px; margin-left: 2px; }
  .dots i { width: 4px; height: 4px; border-radius: 50%; background: var(--muted-2); animation: bounce 1s infinite ease-in-out; }
  .dots i:nth-child(2) { animation-delay: 0.15s; }
  .dots i:nth-child(3) { animation-delay: 0.3s; }
  @keyframes bounce { 0%, 80%, 100% { transform: translateY(0); opacity: 0.5; } 40% { transform: translateY(-3px); opacity: 1; } }

  /* A Bot's shell command: the tail while it runs, one line once it ends */
  .cmd-under { margin: -4px 0 0 36px; max-width: 440px; }
  .cmd { display: flex; flex-direction: column; gap: 4px; max-width: 440px; }
  .cmd-line { display: flex; align-items: center; gap: 6px; font-size: 10.5px; color: var(--muted); min-width: 0; }
  .cmd-text { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
  .cmd-caret { display: inline-block; font-size: 9px; color: var(--muted-2); transition: transform 200ms ease; flex: none; }
  .cmd-caret.open { transform: rotate(90deg); }
  .cmd-pulse { width: 6px; height: 6px; border-radius: 50%; background: var(--accent); flex: none; animation: pulse 1s infinite ease-in-out; }
  @keyframes pulse { 0%, 100% { opacity: 0.35; } 50% { opacity: 1; } }
  .cmd-out {
    font-size: 10.5px; line-height: 1.6; color: var(--ink-2);
    background: var(--sidebar); border: 1px solid var(--line); border-radius: 8px;
    padding: 6px 10px; white-space: pre; overflow: hidden;
  }

  .judgement {
    align-self: flex-end;
    display: flex; align-items: center; gap: 6px; flex-wrap: wrap;
    padding: 5px 8px; border-radius: 8px;
    border: 1px dashed var(--line); color: var(--muted); font-size: 10.5px;
  }
  .j-label { font-weight: 600; margin-right: 2px; }
  .j-chip { display: inline-flex; align-items: center; gap: 4px; padding: 1px 7px 1px 3px; border-radius: 999px; background: var(--sidebar); border: 1px solid var(--line); color: var(--ink-2); }
  .j-chip.join { background: var(--ok-bg); border-color: var(--ok-line); color: var(--ok-text); font-weight: 600; }

  /* Approval card */
  .approval {
    margin-left: 36px; max-width: 520px;
    background: var(--card); border: 1px solid var(--card-line); border-radius: 12px;
    padding: 10px 12px; display: flex; flex-direction: column; gap: 8px;
    transition: background-color 300ms ease, border-color 300ms ease;
  }
  .narrow .approval { margin-left: 0; }
  .approval.allowed { background: var(--pane); border-color: var(--line); }
  .ap-head { display: flex; align-items: center; gap: 8px; }
  .ap-title { font-weight: 600; font-size: 12.5px; flex: 1; }
  .ap-rows { display: grid; grid-template-columns: auto 1fr; gap: 3px 12px; margin: 0; font-size: 11.5px; }
  .ap-rows dt { color: var(--muted); }
  .ap-rows dd { margin: 0; color: var(--ink-2); overflow-wrap: anywhere; }
  .ap-foot { display: flex; align-items: center; gap: 8px; }
  .ap-note { flex: 1; font-size: 10.5px; color: var(--card-ink); }
  .approval.allowed .ap-note { color: var(--muted); }
  .ap-btn { font-size: 11.5px; padding: 4px 11px; border-radius: 7px; border: 1px solid var(--line); background: var(--pane); color: var(--ink-2); font-weight: 600; }
  .ap-btn.primary { background: var(--ink); color: var(--on-ink); border-color: var(--ink); }
  .ap-status { font-size: 11px; font-weight: 600; color: var(--ok-text); background: var(--ok-bg); border-radius: 999px; padding: 2px 9px; }

  /* Composer */
  .composer { padding: 6px 18px 10px; border-top: 1px solid var(--line-2); background: var(--pane); }
  .narrow .composer { padding: 6px 12px 10px; }
  .composer-card { border: 1px solid var(--line); border-radius: 12px; background: var(--pane); box-shadow: 0 1px 2px var(--shadow); padding: 8px 10px 6px; }
  .composer-text { min-height: 20px; font-size: 12.5px; color: var(--ink); }
  .composer-text.placeholder { color: var(--muted-2); }
  .composer-bar { display: flex; align-items: center; justify-content: space-between; margin-top: 4px; }
  .attach { color: var(--muted); display: inline-flex; padding: 3px; }
  .send { width: 26px; height: 26px; border-radius: 50%; display: inline-flex; align-items: center; justify-content: center; background: var(--line); color: var(--muted-2); transition: background-color 200ms ease, color 200ms ease; }
  .send.ready { background: var(--accent); color: #fff; }
  .composer-hint { font-size: 10px; color: var(--muted-2); margin-top: 4px; text-align: right; }

  /* Menus: the ⋯ menu and the pane's right-click menu */
  .menu {
    position: absolute; z-index: 6;
    min-width: 138px; padding: 4px;
    background: var(--pane); border: 1px solid var(--line); border-radius: 9px;
    box-shadow: 0 14px 30px -8px var(--shadow);
    display: flex; flex-direction: column;
  }
  .menu-item { display: flex; align-items: center; gap: 8px; padding: 5px 9px; border-radius: 6px; font-size: 11.5px; color: var(--ink); }
  .menu-item :global(svg) { color: var(--muted); }
  .chat-menu { right: 10px; top: 72px; }
  .split-menu { left: 156px; top: 256px; }
  .rc-anchor { position: absolute; left: 150px; top: 250px; width: 2px; height: 2px; }

  /* ── Artifact preview pane ── */
  .pv { flex: 1; min-height: 0; display: grid; grid-template-columns: 104px 1fr; }
  .pv-tree {
    border-right: 1px solid var(--line); background: var(--sidebar);
    padding: 8px 5px; display: flex; flex-direction: column; gap: 1px; min-width: 0;
  }
  .tr-row {
    display: flex; align-items: center; gap: 5px; min-width: 0;
    padding: 3px 5px; border-radius: 5px;
    font-size: 10.5px; color: var(--ink-2); white-space: nowrap;
  }
  .tr-row span { overflow: hidden; text-overflow: ellipsis; }
  .tr-row :global(svg) { color: var(--muted); flex: none; }
  .tr-row.sub { padding-left: 16px; }
  .tr-row.on { background: var(--accent-tint); color: var(--accent); font-weight: 600; }
  .tr-row.on :global(svg) { color: var(--accent); }
  .pv-editor { position: relative; min-width: 0; min-height: 0; display: flex; flex-direction: column; }
  .pv-toggle {
    position: absolute; top: 8px; left: 50%; transform: translateX(-50%); z-index: 2;
    display: inline-flex; border: 1px solid var(--line); border-radius: 7px; overflow: hidden;
    font-size: 10.5px; background: var(--pane); box-shadow: 0 2px 6px -2px var(--shadow);
  }
  .pv-toggle span { padding: 2px 8px; color: var(--muted); }
  .pv-toggle .on { background: var(--sidebar); color: var(--ink); font-weight: 600; }
  .pv-body { flex: 1; overflow: hidden; padding: 40px 0 8px; font-family: var(--mono); font-size: 10.5px; line-height: 1.75; }
  .code-line { display: flex; gap: 10px; padding: 0 10px; white-space: pre; min-width: 0; }
  .ln { width: 16px; text-align: right; color: var(--muted-2); flex: none; font-variant-numeric: tabular-nums; }
  .code { color: var(--ink-2); overflow: hidden; text-overflow: ellipsis; min-width: 0; }
  .code.h { color: var(--accent); font-weight: 600; }
  .code.q { color: var(--muted); font-style: italic; }
  .code-line.edit { background: var(--accent-tint); }
  .code-line.edit :global(.tw) { white-space: pre; overflow-wrap: normal; }
  .pv-toast {
    position: absolute; left: 10px; right: 10px; bottom: 10px;
    background: var(--ink); color: var(--on-ink); font-size: 11px; padding: 6px 10px; border-radius: 8px;
  }

  /* ── Flow board pane ── */
  .flow { flex: 1; min-height: 0; display: flex; flex-direction: column; }
  .fl-bar { height: 34px; flex: none; display: flex; align-items: center; gap: 5px; padding: 0 8px; border-bottom: 1px solid var(--line); }
  .fl-job {
    flex: 1; min-width: 0;
    display: inline-flex; align-items: center; gap: 5px;
    padding: 3px 7px; border: 1px solid var(--line); border-radius: 7px;
    font-size: 10.5px; color: var(--ink);
  }
  .fl-job :global(svg) { color: var(--muted); flex: none; }
  .fl-job-title { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
  .fl-chev { color: var(--muted); flex: none; }
  .fl-toggle {
    flex: none; font-size: 10px; color: var(--muted);
    padding: 2px 7px; border: 1px solid var(--line); border-radius: 999px; white-space: nowrap;
  }
  .fl-toggle b { font-weight: 600; color: var(--ink-2); margin-left: 4px; }
  .fl-canvas {
    position: relative; flex: 1; min-height: 0; overflow: hidden;
    background-color: var(--sidebar);
    background-image: radial-gradient(var(--line) 1px, transparent 1px);
    background-size: 14px 14px;
  }
  .fl-board {
    position: absolute; left: 50%; top: 14px; width: 256px;
    transform-origin: top center;
    display: flex; flex-direction: column;
    transition: transform 360ms cubic-bezier(0.2, 0.7, 0.2, 1);
  }
  .card {
    background: var(--pane); border: 1px solid var(--line); border-radius: 10px;
    padding: 8px 10px; box-shadow: 0 1px 2px var(--shadow);
    display: flex; flex-direction: column; gap: 5px;
  }
  .card.running { border-color: var(--accent-line); box-shadow: 0 0 0 2px var(--accent-tint); }
  .c-head { display: flex; align-items: center; gap: 6px; }
  .c-name { font-weight: 600; font-size: 11.5px; flex: 1; }
  .c-status { font-size: 10px; padding: 0 7px; border-radius: 999px; line-height: 1.7; font-weight: 600; }
  .c-status.done { color: var(--ok-text); background: var(--ok-bg); }
  .c-status.running { color: var(--accent); background: var(--accent-tint); }
  .c-text {
    margin: 0; font-size: 10.5px; color: var(--ink-2); line-height: 1.45;
    display: -webkit-box; -webkit-line-clamp: 2; line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden;
  }
  .c-meta { font-size: 10px; color: var(--muted); }
  .c-files { display: flex; }
  .c-files .artifact { font-size: 10px; padding: 2px 7px 2px 5px; }
  .c-route {
    display: flex; align-items: center; gap: 5px; min-width: 0;
    padding: 3px 7px; border-radius: 6px;
    background: var(--sidebar); border: 1px solid var(--line-2);
    font-size: 10px; color: var(--muted); white-space: nowrap;
  }
  .c-model { color: var(--ink); font-weight: 600; }
  .c-detail { border-top: 1px dashed var(--line); padding-top: 6px; display: flex; flex-direction: column; gap: 3px; }
  .c-detail .lbl { font-size: 10px; font-weight: 600; color: var(--muted); }
  .c-detail p { margin: 0; font-size: 10.5px; color: var(--ink-2); line-height: 1.5; }
  .c-detail .exec { font-size: 10px; color: var(--muted-2); font-variant-numeric: tabular-nums; }
  .link { display: block; width: 2px; height: 16px; margin: 0 auto; background: var(--muted-2); opacity: 0.6; position: relative; }
  .link::after {
    content: ''; position: absolute; left: -3px; bottom: -1px;
    border: 4px solid transparent; border-top-color: var(--muted-2); border-bottom: 0;
  }

  /* ── Empty pane ── */
  .empty-pane { flex: 1; min-height: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 4px; padding: 10px 18px; }
  .ep-title { margin: 0; font-weight: 600; font-size: 12px; }
  .ep-hint { margin: 0 0 6px; font-size: 10.5px; color: var(--muted); text-align: center; }
  .ep-list { width: 232px; display: flex; flex-direction: column; gap: 2px; }
  .ep-filter {
    display: flex; align-items: center; gap: 6px; margin-bottom: 4px;
    padding: 4px 8px; border: 1px solid var(--line); border-radius: 7px;
    font-size: 10.5px; color: var(--muted-2);
  }
  .ep-row { display: flex; align-items: center; gap: 8px; padding: 4px 8px; border-radius: 6px; font-size: 11.5px; color: var(--ink); }
  .ep-row :global(svg) { color: var(--muted); }
  .ep-sect { margin-top: 6px; padding: 0 8px; font-size: 10px; font-weight: 600; color: var(--muted); }
  .ep-none { padding: 2px 8px; font-size: 10.5px; color: var(--muted-2); }

  /* ── Terminal pane ── */
  .term { flex: 1; min-height: 0; display: flex; flex-direction: column; }
  .term-head { height: 28px; flex: none; display: flex; align-items: center; gap: 6px; padding: 0 10px; border-bottom: 1px solid var(--line); }
  .term-path { flex: 1; font-size: 10.5px; color: var(--muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .t-btn { font-size: 10.5px; color: var(--ink-2); padding: 1px 7px; border: 1px solid var(--line); border-radius: 6px; }
  .term-body { flex: 1; overflow: hidden; padding: 8px 12px; font-size: 11px; line-height: 1.65; color: var(--ink); white-space: pre; }
  .t-cwd { color: var(--accent); }
  .t-prompt { color: var(--ok-text); }
  .t-dim { color: var(--muted); }
  .t-ok { color: var(--ok-text); font-weight: 600; }
  .t-link { color: var(--ink-2); }

  /* Settings modal */
  .backdrop { position: absolute; inset: 0; background: rgba(2, 6, 23, 0.45); }
  .modal {
    position: absolute; left: 50%; top: 50%; transform: translate(-50%, -50%);
    width: 540px; background: var(--pane); border-radius: 14px;
    box-shadow: 0 30px 60px -20px var(--shadow), 0 0 0 1px var(--line);
    padding: 14px 18px 14px; display: flex; flex-direction: column; gap: 10px;
  }
  .modal-head { display: flex; align-items: center; justify-content: space-between; }
  .modal-title { font-weight: 600; font-size: 14px; }
  .tabs { display: inline-flex; gap: 2px; background: var(--sidebar); border: 1px solid var(--line); border-radius: 8px; padding: 2px; }
  .stab { font-size: 11px; padding: 2px 9px; border-radius: 6px; color: var(--muted); }
  .stab.on { background: var(--pane); color: var(--ink); font-weight: 600; box-shadow: 0 1px 2px var(--shadow); }
  .wizard-hint { margin: 0; font-size: 11px; color: var(--muted); }

  .field { display: flex; flex-direction: column; gap: 4px; }
  .field.two { display: grid; grid-template-columns: 1fr 1.6fr; gap: 10px; }
  .field.two > div { display: flex; flex-direction: column; gap: 4px; }
  .field .label { font-size: 11px; font-weight: 600; color: var(--ink-2); }
  .input {
    min-height: 28px; border: 1px solid var(--line); border-radius: 8px; background: var(--pane);
    padding: 4px 9px; font-size: 12px; color: var(--ink); display: flex; align-items: center;
  }
  .input.tall { min-height: 44px; align-items: flex-start; }
  .input.key { letter-spacing: 0.08em; flex: 0 0 56%; color: var(--ink-2); }
  .key-row { display: flex; align-items: center; gap: 8px; }
  .chip-ok { font-size: 10.5px; font-weight: 600; color: var(--ok-text); background: var(--ok-bg); border-radius: 999px; padding: 2px 8px; }
  .field-hint { font-size: 10.5px; color: var(--muted); }

  .models { border: 1px solid var(--line); border-radius: 8px; overflow: hidden; }
  .m-row { display: grid; grid-template-columns: 1.35fr 1.2fr 1.1fr 0.65fr; gap: 8px; padding: 5px 10px; font-size: 11px; color: var(--ink-2); border-top: 1px solid var(--line-2); align-items: center; }
  .m-row.head { border-top: 0; background: var(--sidebar); color: var(--muted); font-weight: 600; font-size: 10.5px; }
  .m-name-cell { display: inline-flex; align-items: center; gap: 6px; min-width: 0; }
  .m-dot { width: 8px; height: 8px; border-radius: 50%; border: 1.5px solid var(--muted-2); flex: none; }
  .m-dot.on { border-color: var(--accent); background: var(--accent); }
  .m-name { color: var(--ink); font-weight: 600; }
  .m-default { font-size: 9.5px; color: var(--accent); font-weight: 600; }
  .modal-foot, .sheet-foot { display: flex; justify-content: flex-end; }
  .btn-dark { background: var(--ink); color: var(--on-ink); font-size: 12px; font-weight: 600; padding: 6px 16px; border-radius: 8px; }

  /* New bot sheet */
  .sheet {
    position: absolute; left: 200px; top: 0; bottom: 0; width: 320px;
    background: var(--pane); border-right: 1px solid var(--line);
    box-shadow: 16px 0 36px -6px var(--shadow);
    padding: 16px 16px; display: flex; flex-direction: column; gap: 12px;
  }
  .sheet-head { font-weight: 600; font-size: 14px; }
  .avatar-row { display: flex; align-items: center; gap: 12px; }
  .avatar-frame { width: 48px; height: 48px; border-radius: 50%; border: 1px dashed var(--line); display: inline-flex; align-items: center; justify-content: center; }
  .avatar-meta { display: flex; flex-direction: column; gap: 4px; }
  .avatar-meta .label { font-size: 11px; font-weight: 600; color: var(--ink-2); }
  .sheet-foot { margin-top: auto; }

  /* Desk / tray */
  .desk { position: absolute; inset: 0; background: var(--bg); }
  .menubar {
    height: 26px; background: var(--glass); border-bottom: 1px solid var(--line);
    display: flex; align-items: center; gap: 14px; padding: 0 12px; font-size: 11.5px; color: var(--ink-2);
  }
  .apple { width: 12px; height: 12px; border-radius: 50%; background: var(--ink); opacity: 0.85; }
  .mb-item.strong { font-weight: 600; color: var(--ink); }
  .mb-spacer { flex: 1; }
  .tray-icon { display: inline-flex; padding: 2px 5px; border-radius: 5px; color: var(--ink); }
  .tray-icon.open { background: var(--line); }
  .tray-menu {
    position: absolute; right: 52px; top: 30px; width: 170px;
    background: var(--pane); border: 1px solid var(--line); border-radius: 9px;
    box-shadow: 0 12px 28px -6px var(--shadow); padding: 4px; font-size: 12px;
  }
  .tm-item { display: flex; justify-content: space-between; padding: 4px 10px; border-radius: 6px; color: var(--ink); }
  .tm-item:first-child { background: var(--accent); color: #fff; }
  .tm-sep { display: block; height: 1px; background: var(--line); margin: 3px 6px; }
  .desk-status {
    position: absolute; left: 50%; top: 50%; transform: translate(-50%, -52%);
    background: var(--pane); border: 1px solid var(--line); border-radius: 12px;
    padding: 14px 18px; display: flex; flex-direction: column; gap: 10px; min-width: 320px;
    box-shadow: 0 12px 28px -12px var(--shadow);
  }
  .ds-title { margin: 0; font-weight: 600; font-size: 13px; }
  .ds-turns { display: flex; flex-direction: column; gap: 8px; }
  .term-rep :global(svg) { color: var(--accent); }
  .term-rep .mono { font-size: 11px; }

  .banner {
    position: absolute; right: 12px; top: 36px; width: 300px; z-index: 2;
    display: flex; gap: 10px; align-items: flex-start;
    padding: 10px 12px; border-radius: 14px;
    background: var(--glass); border: 1px solid var(--line);
    box-shadow: 0 16px 36px -12px var(--shadow);
  }
  .bn-icon { flex: none; width: 34px; height: 34px; border-radius: 9px; background: var(--pane); border: 1px solid var(--line); display: inline-flex; align-items: center; justify-content: center; }
  .bn-text { min-width: 0; display: flex; flex-direction: column; gap: 1px; }
  .bn-top { display: flex; justify-content: space-between; gap: 8px; font-size: 10px; color: var(--muted); }
  .bn-app { font-weight: 600; letter-spacing: 0.02em; }
  .bn-title { font-size: 12px; font-weight: 600; color: var(--ink); }
  .bn-body {
    font-size: 11px; color: var(--ink-2); line-height: 1.45;
    display: -webkit-box; -webkit-line-clamp: 2; line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden;
  }

  .dock {
    position: absolute; left: 50%; bottom: 12px; transform: translateX(-50%);
    display: flex; align-items: flex-end; gap: 10px;
    padding: 7px 12px; border-radius: 18px;
    background: var(--glass); border: 1px solid var(--line);
    box-shadow: 0 10px 26px -12px var(--shadow);
  }
  .dk-app { position: relative; width: 44px; height: 44px; border-radius: 11px; display: inline-flex; align-items: center; justify-content: center; }
  .dk-app.a { background: linear-gradient(160deg, #60a5fa, #2563eb); }
  .dk-app.b { background: linear-gradient(160deg, #fcd34d, #f59e0b); }
  .dk-app.c { background: linear-gradient(160deg, #94a3b8, #475569); }
  .dk-app.rb { background: #ffffff; border: 1px solid var(--line); }
  .dk-badge {
    position: absolute; right: -6px; top: -6px;
    min-width: 18px; height: 18px; padding: 0 5px; border-radius: 999px;
    background: #ef4444; color: #fff; font-size: 11px; font-weight: 700;
    display: inline-flex; align-items: center; justify-content: center;
    box-shadow: 0 0 0 2px var(--glass);
  }
  .dk-dot { position: absolute; bottom: -6px; left: 50%; width: 4px; height: 4px; margin-left: -2px; border-radius: 50%; background: var(--ink-2); }

  /* Callout */
  .callout {
    position: absolute; z-index: 7;
    background: var(--paper); color: var(--ink);
    border-left: 3px solid var(--teal); border-radius: 6px;
    padding: 7px 10px; font-size: 12px; line-height: 1.45;
    box-shadow: 0 10px 24px -10px var(--shadow), 0 0 0 1px var(--line);
    transition: left 320ms ease, top 320ms ease;
  }
  .callout::before {
    content: ''; position: absolute; top: 16px; left: -9px;
    border: 6px solid transparent; border-right-color: var(--teal); border-left: 0;
  }
  .callout.left { border-left: 0; border-right: 3px solid var(--teal); }
  .callout.left::before { left: auto; right: -9px; border-right: 0; border-left: 6px solid var(--teal); }
  .callout.below { border-left: 0; border-top: 3px solid var(--teal); }
  .callout.below::before { top: -9px; left: 16px; border: 6px solid transparent; border-top: 0; border-bottom-color: var(--teal); }

  /* Cursor */
  .cursor {
    position: absolute; left: 0; top: 0; z-index: 8; pointer-events: none;
    opacity: 0; transition: transform 420ms cubic-bezier(0.3, 0.8, 0.3, 1), opacity 200ms ease;
    filter: drop-shadow(0 2px 3px rgba(0, 0, 0, 0.35));
  }
  .cursor path { fill: var(--ink); stroke: var(--pane); }
  .cursor.visible { opacity: 1; }
  .cursor svg { position: absolute; left: -4px; top: -3px; }
  .ripple {
    position: absolute; left: -10px; top: -10px; width: 20px; height: 20px; border-radius: 50%;
    border: 2px solid var(--teal); opacity: 0; transform: scale(0.4);
  }
  .cursor.clicking .ripple { animation: ripple 320ms ease-out; }
  @keyframes ripple { 0% { opacity: 0.9; transform: scale(0.4); } 100% { opacity: 0; transform: scale(1.6); } }

  @media (max-width: 1023px) {
    .callout { display: none; }
  }

  @media (prefers-reduced-motion: reduce) {
    .frame, .callout, .cursor, .approval, .send, .fl-board, .cmd-caret { transition: none; }
    .dots i, .cmd-pulse { animation: none; }
  }
</style>
