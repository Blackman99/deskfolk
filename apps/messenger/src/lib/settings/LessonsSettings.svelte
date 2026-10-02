<script lang="ts">
	import type { Lesson, LessonPatch } from '@real-bot/protocol';
	import type { Copy } from '../copy.ts';
	import { formatFullTimestamp, formatMessageTime } from '../chat/chat-view.ts';

	interface Props {
		lessons: readonly Lesson[];
		t: Copy;
		/** Your edit; resolves with the lesson as saved, rejects when it did not go through. */
		onPatch: (id: string, patch: LessonPatch) => Promise<Lesson>;
	}

	let { lessons, t, onPatch }: Props = $props();

	// What you changed here, until the list is read again.
	let saved = $state<Record<string, Lesson>>({});
	let busy = $state<string | null>(null);
	let failed = $state<string | null>(null);
	const shown = $derived(lessons.map((lesson) => saved[lesson.id] ?? lesson));

	async function patch(lesson: Lesson, change: LessonPatch): Promise<void> {
		if (busy) return;
		busy = lesson.id;
		failed = null;
		try {
			saved = { ...saved, [lesson.id]: await onPatch(lesson.id, change) };
		} catch {
			failed = lesson.id;
		} finally {
			busy = null;
		}
	}

	function lastSeen(lesson: Lesson): string | null {
		return lesson.evidence.at(-1)?.at ?? null;
	}

	/** A shell lesson's kind of call; a reflection's, what it is (ADR 0051). */
	function kindOf(lesson: Lesson): string {
		if (lesson.detector.tool === 'shell') return lesson.detector.head;
		if (lesson.action === 'propose_check') return t.lessons.checkProposal;
		return t.lessons.checklistAt[lesson.hook as 'before_review' | 'before_submit' | 'before_generate'] ?? lesson.hook;
	}

	function badgeOf(lesson: Lesson): { tone: string; label: string } {
		if (lesson.status === 'retired') return { tone: 'retired', label: t.lessons.retired };
		if (lesson.status === 'candidate') return { tone: 'candidate', label: t.lessons.candidate };
		if (lesson.detector.tool !== 'shell') return { tone: 'adopted', label: t.lessons.adopted };
		return lesson.action === 'block' ? { tone: 'block', label: t.lessons.block } : { tone: 'warn', label: t.lessons.warn };
	}
</script>

<div class="lessons-settings">
	<section class="settings-card">
		<div class="settings-card-header">
			<div>
				<h3 class="settings-card-title">{t.lessons.title}</h3>
				<p class="settings-card-subtitle">{t.lessons.subtitle}</p>
			</div>
		</div>
		<ul class="lesson-list">
			{#each shown as lesson (lesson.id)}
				<li class="lesson" class:is-retired={lesson.status === 'retired'} data-lesson={lesson.id}>
					<div class="lesson-head">
						{#if lesson.detector.tool === 'shell'}
							<code class="lesson-kind">{kindOf(lesson)}</code>
						{:else}
							<span class="lesson-kind">{kindOf(lesson)}</span>
						{/if}
						<span class="lesson-badge is-{badgeOf(lesson).tone}">{badgeOf(lesson).label}</span>
					</div>
					<p class="lesson-text">{lesson.text}</p>
					{#if lesson.detector.check}
						<p class="lesson-check">
							<span>{t.lessons.checkKind[lesson.detector.check.kind as 'exists' | 'contains' | 'matches'] ?? lesson.detector.check.kind}</span>
							<code>{lesson.detector.check.path ?? ''}</code>
							{#if lesson.detector.check.pattern}<code>{lesson.detector.check.pattern}</code>{/if}
						</p>
					{/if}
					<p class="lesson-stats">
						{#if lesson.detector.tool === 'shell'}{t.lessons.stats(lesson.hits, lesson.prevented, lesson.recurrences)}{:else}{t.lessons.fromReflection}{/if}
						{#if lastSeen(lesson)}
							<span title={formatFullTimestamp(lastSeen(lesson)!)}> · {t.lessons.lastSeen(formatMessageTime(lastSeen(lesson)!))}</span>
						{/if}
					</p>
					<div class="lesson-actions">
						{#if lesson.status === 'retired'}
							{#if lesson.detector.tool === 'shell' || (lesson.action === 'checklist' && lesson.confirmed_at)}
								<button type="button" class="lesson-button" disabled={busy !== null} onclick={() => patch(lesson, { status: 'active' })}>{t.lessons.restore}</button>
							{/if}
						{:else}
							{#if lesson.detector.tool === 'shell'}
								<button
									type="button"
									class="lesson-button"
									disabled={busy !== null}
									onclick={() => patch(lesson, { action: lesson.action === 'block' ? 'warn' : 'block' })}
								>
									{lesson.action === 'block' ? t.lessons.toWarn : t.lessons.toBlock}
								</button>
							{/if}
							<button type="button" class="lesson-button" disabled={busy !== null} onclick={() => patch(lesson, { status: 'retired' })}>{t.lessons.retire}</button>
						{/if}
						{#if failed === lesson.id}
							<span class="lesson-failed" role="status">{t.lessons.failed}</span>
						{/if}
					</div>
				</li>
			{/each}
		</ul>
	</section>
</div>

<style>
	.lessons-settings {
		display: flex;
		flex-direction: column;
		gap: 14px;
	}

	.settings-card {
		background: var(--pane);
		border: 1px solid var(--line);
		border-radius: var(--radius-lg);
		padding: 16px 18px;
		display: flex;
		flex-direction: column;
		gap: 14px;
		box-shadow: var(--shadow-xs);
		box-sizing: border-box;
	}

	.settings-card-title {
		margin: 0;
		font-size: 14px;
		font-weight: 600;
		color: var(--ink);
		line-height: 1.3;
	}

	.settings-card-subtitle {
		margin: 2px 0 0;
		font-size: 12px;
		color: var(--muted);
		line-height: 1.35;
	}

	.lesson-list {
		list-style: none;
		margin: 0;
		padding: 0;
		display: flex;
		flex-direction: column;
		gap: 10px;
	}

	.lesson {
		display: flex;
		flex-direction: column;
		gap: 6px;
		padding: 10px 12px;
		border: 1px solid var(--line);
		border-radius: var(--radius-md);
		background: var(--surface, var(--pane));
	}

	.lesson.is-retired {
		opacity: 0.65;
	}

	.lesson-head {
		display: flex;
		align-items: center;
		gap: 8px;
		min-width: 0;
	}

	.lesson-kind {
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		font-size: 12px;
		color: var(--ink);
	}

	.lesson-badge {
		flex: none;
		padding: 1px 7px;
		border: 1px solid var(--line);
		border-radius: var(--radius-full);
		background: var(--chip);
		font-size: 11px;
		font-weight: 600;
		color: var(--muted);
	}

	.lesson-badge.is-warn {
		border-color: var(--warn-line);
		background: var(--warn-bg);
		color: var(--warn-text);
	}

	.lesson-badge.is-candidate {
		border-color: var(--accent-border);
		background: var(--accent-tint);
		color: var(--accent);
	}

	.lesson-badge.is-adopted {
		border-color: var(--ok-line);
		background: var(--ok-bg);
		color: var(--ok-text);
	}

	.lesson-badge.is-block {
		border-color: var(--danger-line);
		background: var(--danger-bg);
		color: var(--danger-text);
	}

	.lesson-text,
	.lesson-stats {
		margin: 0;
		line-height: 1.45;
		overflow-wrap: anywhere;
	}

	.lesson-text {
		font-size: 13px;
		color: var(--ink-secondary);
	}

	.lesson-stats {
		font-size: 11px;
		color: var(--muted);
	}

	.lesson-check {
		display: flex;
		flex-wrap: wrap;
		align-items: baseline;
		gap: 6px;
		margin: 0;
		font-size: 12px;
		color: var(--muted);
		overflow-wrap: anywhere;
	}

	.lesson-check code {
		padding: 0 4px;
		border-radius: var(--radius-sm);
		background: var(--chip);
		color: var(--ink);
	}

	.lesson-actions {
		display: flex;
		align-items: center;
		flex-wrap: wrap;
		gap: 6px;
	}

	.lesson-button {
		padding: 3px 10px;
		border: 1px solid var(--line);
		border-radius: var(--radius-full);
		background: var(--pane);
		color: var(--ink-secondary);
		font-size: 12px;
		cursor: pointer;
	}

	.lesson-button:hover:not(:disabled) {
		border-color: var(--accent-border);
		color: var(--accent);
	}

	.lesson-button:disabled {
		cursor: default;
		opacity: 0.6;
	}

	.lesson-failed {
		font-size: 11px;
		color: var(--danger-text);
	}

	@media (max-width: 680px) {
		.settings-card {
			padding: 14px 12px;
			border-radius: var(--radius-md);
			gap: 12px;
		}
	}
</style>
