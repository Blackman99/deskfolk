<script lang="ts">
	import type { Bot, Retrospective, RetrospectiveChange, TaskDetail } from '@real-bot/protocol';
	import { ApiError } from '../api.ts';
	import type { Copy } from '../copy.ts';
	import type { MessengerApi } from '../messenger-api.ts';
	import { formatFullTimestamp, formatMessageTime } from '../chat/chat-view.ts';
	import { changedLines, changeTitle, failedText, reasonText, shownRetrospectives } from './plan-retrospectives.ts';

	interface Props {
		api: MessengerApi | null;
		detail: TaskDetail;
		t: Copy;
		/** The Bots, for a retrospective's name; one deleted since reads as deleted. */
		bots: readonly Bot[];
		deletedLabel: string;
		/** The plan comes back whole after an undo; the parent replaces its copy. */
		onSaved: (detail: TaskDetail) => void;
	}

	/**
	 * What the plan's Bots made of it once it was delivered (ADR 0062): what tripped each up, what
	 * made you send work back, what to keep, and the changes to its own memories and skills — each
	 * with what it replaced and a 撤销. Nothing here asks you anything: it is shown, not put to you.
	 */
	let { api, detail, t, bots, deletedLabel, onSaved }: Props = $props();

	const c = $derived(t.plan.retrospective);
	const retrospectives = $derived(shownRetrospectives(detail.retrospectives));
	const names = $derived(new Map(bots.map((bot) => [bot.id, bot.name] as const)));
	let pending = $state<string | null>(null);
	let failed = $state<{ key: string; message: string } | null>(null);

	function botName(id: string): string {
		return names.get(id) ?? deletedLabel;
	}

	async function undo(retrospective: Retrospective, index: number): Promise<void> {
		if (!api || pending) return;
		const key = `${retrospective.id}:${index}`;
		pending = key;
		failed = null;
		try {
			onSaved(await api.undoRetrospectiveChange(retrospective.id, index));
		} catch (error) {
			failed = { key, message: error instanceof ApiError && error.status === 409 ? c.undoChanged : c.undoFailed };
		} finally {
			pending = null;
		}
	}

	function sideText(change: RetrospectiveChange, side: 'before' | 'after'): string {
		const value = change[side];
		return value ? value.body : '';
	}
</script>

{#snippet findings(label: string, lines: readonly string[], tone: string)}
	{#if lines.length > 0}
		<div class="plan-retro-list is-{tone}">
			<span class="plan-retro-list-label">{label}</span>
			<ul>
				{#each lines as line, index (index)}<li>{line}</li>{/each}
			</ul>
		</div>
	{/if}
{/snippet}

<section class="plan-retros" aria-label={c.title}>
	<div class="plan-retros-head">
		<span class="plan-retros-title">{c.title}</span>
		<span class="plan-retros-count mono">{retrospectives.length}</span>
	</div>
	<p class="plan-retros-hint">{c.hint}</p>
	{#each retrospectives as retrospective (retrospective.id)}
		<article class="plan-retro" data-retrospective={retrospective.id}>
			<div class="plan-retro-head">
				<span class="plan-retro-bot">{botName(retrospective.bot_id)}</span>
				<span class="plan-retro-time" title={formatFullTimestamp(retrospective.finished_at ?? retrospective.created_at)}>
					{formatMessageTime(retrospective.finished_at ?? retrospective.created_at)}
				</span>
			</div>
			{#if retrospective.state === 'pending'}
				<p class="plan-retro-muted">{c.running(botName(retrospective.bot_id))}</p>
			{:else if retrospective.state === 'failed'}
				<p class="plan-retro-muted">{failedText(retrospective.note, c)}</p>
			{:else}
				{#if retrospective.summary}<p class="plan-retro-summary">{retrospective.summary}</p>{/if}
				{@render findings(c.reworkCauses, retrospective.rework_causes, 'rework')}
				{@render findings(c.pitfalls, retrospective.pitfalls, 'pitfall')}
				{@render findings(c.keep, retrospective.keep, 'keep')}
				{#if retrospective.earlier.length > 0}
					<div class="plan-retro-list is-earlier">
						<span class="plan-retro-list-label">{c.earlier}</span>
						<ul>
							{#each retrospective.earlier as item, index (index)}
								<li><span class="plan-retro-verdict is-{item.verdict}">{c.verdict[item.verdict]}</span> {item.conclusion}</li>
							{/each}
						</ul>
					</div>
				{/if}
				<div class="plan-retro-changes">
					<span class="plan-retro-list-label">{c.changes}</span>
					{#if retrospective.changes.length === 0}
						<p class="plan-retro-muted">{c.noChanges}</p>
					{:else}
						<ul>
							{#each retrospective.changes as change, index (index)}
								{@const key = `${retrospective.id}:${index}`}
								<li class="plan-retro-change is-{change.status}" data-change={index}>
									<div class="plan-retro-change-line">
										<span class="plan-retro-change-title">{changeTitle(change, c)}</span>
										{#if change.status === 'applied' && api}
											<button
												type="button"
												class="plan-retro-undo"
												disabled={pending !== null}
												aria-busy={pending === key ? 'true' : undefined}
												onclick={() => void undo(retrospective, index)}>{c.undo}</button
											>
										{:else if change.status === 'undone'}
											<span class="plan-retro-tag">{c.undone}</span>
										{/if}
									</div>
									{#if change.status === 'not_applied'}
										<div class="plan-retro-reason">{c.notApplied(reasonText(change.reason, c))}</div>
									{/if}
									{#if change.why}<div class="plan-retro-why">{change.why}</div>{/if}
									{#if change.status !== 'not_applied' && (change.before || change.after)}
										<details class="plan-retro-diff">
											<summary>{c.showDiff}</summary>
											{#if change.kind === 'skill' && change.before && change.after}
												<div class="plan-retro-lines">
													{#each changedLines(change.before.body, change.after.body) as line, at (at)}
														{#if line.kind === 'gap'}
															<div class="plan-retro-line is-gap" aria-hidden="true">…</div>
														{:else}
															<div class="plan-retro-line is-{line.kind}"><span class="plan-retro-mark" aria-hidden="true">{line.kind === 'add' ? '+' : '−'}</span>{line.text}</div>
														{/if}
													{/each}
												</div>
											{:else}
												{#if change.before}
													<div class="plan-retro-side is-before"><span class="plan-retro-side-label">{c.before}</span>{sideText(change, 'before')}</div>
												{/if}
												{#if change.after}
													<div class="plan-retro-side is-after"><span class="plan-retro-side-label">{c.after}</span>{sideText(change, 'after')}</div>
												{/if}
											{/if}
										</details>
									{/if}
									{#if failed?.key === key}<div class="plan-retro-error" role="status">{failed.message}</div>{/if}
								</li>
							{/each}
						</ul>
					{/if}
				</div>
			{/if}
		</article>
	{/each}
</section>

<style>
	.plan-retros {
		display: flex;
		flex-direction: column;
		gap: 7px;
		min-width: 0;
		padding: 10px 11px;
		border-radius: var(--radius-md);
		border: 1px solid var(--line);
		background: var(--pane);
	}

	.plan-retros-head {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		min-width: 0;
	}

	.plan-retros-title {
		font-weight: 600;
		color: var(--muted);
		font-size: 12px;
	}

	.plan-retros-count {
		padding: 0 5px;
		border-radius: var(--radius-full);
		background: var(--line-subtle);
		color: var(--muted);
		font-size: 10px;
		font-weight: 700;
		line-height: 15px;
	}

	.plan-retros-hint,
	.plan-retro-muted {
		margin: 0;
		font-size: 11px;
		color: var(--muted-light);
	}

	.plan-retro {
		display: flex;
		flex-direction: column;
		gap: 6px;
		min-width: 0;
		padding-top: 8px;
		border-top: 1px dashed var(--line);
	}

	.plan-retro-head {
		display: flex;
		align-items: baseline;
		gap: 8px;
		min-width: 0;
	}

	.plan-retro-bot {
		font-size: 12px;
		font-weight: 600;
		color: var(--ink);
	}

	.plan-retro-time {
		font-size: 11px;
		color: var(--muted);
	}

	.plan-retro-summary {
		margin: 0;
		font-size: 12px;
		line-height: 1.5;
		color: var(--ink);
		overflow-wrap: anywhere;
	}

	.plan-retro-list,
	.plan-retro-changes {
		display: flex;
		flex-direction: column;
		gap: 3px;
		min-width: 0;
	}

	.plan-retro-list-label {
		font-size: 11px;
		font-weight: 600;
		color: var(--muted);
	}

	.plan-retro-list ul,
	.plan-retro-changes ul {
		margin: 0;
		padding: 0 0 0 14px;
		display: flex;
		flex-direction: column;
		gap: 2px;
		font-size: 11.5px;
		line-height: 1.45;
		color: var(--ink-secondary);
		overflow-wrap: anywhere;
	}

	.plan-retro-changes ul {
		padding-left: 0;
		list-style: none;
		gap: 6px;
	}

	.plan-retro-verdict {
		font-weight: 600;
		color: var(--muted);
	}

	.plan-retro-verdict.is-recurred {
		color: var(--danger-text);
	}

	.plan-retro-change {
		display: flex;
		flex-direction: column;
		gap: 2px;
		min-width: 0;
	}

	.plan-retro-change-line {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 8px;
		min-width: 0;
	}

	.plan-retro-change-title {
		min-width: 0;
		font-size: 12px;
		color: var(--ink);
		overflow-wrap: anywhere;
	}

	.plan-retro-change.is-undone .plan-retro-change-title,
	.plan-retro-change.is-not_applied .plan-retro-change-title {
		color: var(--muted);
	}

	.plan-retro-change.is-undone .plan-retro-change-title {
		text-decoration: line-through;
	}

	.plan-retro-reason,
	.plan-retro-why {
		font-size: 11px;
		color: var(--muted);
		overflow-wrap: anywhere;
	}

	.plan-retro-tag {
		flex: none;
		font-size: 11px;
		color: var(--muted);
	}

	.plan-retro-undo {
		flex: none;
		min-height: 24px;
		padding: 2px 8px;
		border: 1px solid var(--line);
		border-radius: var(--radius-sm);
		background: var(--chip);
		color: var(--ink-secondary);
		font-size: 11px;
		font-weight: 500;
		cursor: pointer;
		transition: 0.15s ease;
		transition-property: var(--transition-props);
	}

	.plan-retro-undo:hover:not(:disabled) {
		border-color: var(--accent-border);
		background: var(--accent-tint);
		color: var(--accent);
	}

	.plan-retro-undo:disabled {
		opacity: 0.55;
		cursor: not-allowed;
	}

	.plan-retro-diff summary {
		font-size: 11px;
		color: var(--accent);
		cursor: pointer;
	}

	.plan-retro-lines,
	.plan-retro-side {
		margin-top: 4px;
		font-size: 11px;
		line-height: 1.45;
		white-space: pre-wrap;
		overflow-wrap: anywhere;
	}

	.plan-retro-line {
		padding: 1px 5px;
		border-radius: var(--radius-xs);
	}

	.plan-retro-line.is-add {
		background: var(--accent-tint);
		color: var(--ink);
	}

	.plan-retro-line.is-del {
		color: var(--muted);
		text-decoration: line-through;
	}

	.plan-retro-line.is-gap {
		color: var(--muted-light);
	}

	.plan-retro-mark {
		display: inline-block;
		width: 12px;
		color: var(--muted);
	}

	.plan-retro-side {
		display: flex;
		flex-direction: column;
		gap: 1px;
		padding: 4px 6px;
		border-radius: var(--radius-xs);
		background: var(--line-subtle);
		color: var(--ink-secondary);
	}

	.plan-retro-side.is-before {
		color: var(--muted);
	}

	.plan-retro-side-label {
		font-weight: 600;
		color: var(--muted);
	}

	.plan-retro-error {
		font-size: 11px;
		color: var(--danger-text);
	}

	@media (max-width: 560px) {
		.plan-retro-undo {
			min-height: 32px;
			padding: 4px 10px;
		}
	}
</style>
