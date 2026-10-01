<script lang="ts">
	import type { WorkAnswerResult, WorkQuestionControl } from '@real-bot/protocol';
	import { ApiError } from '../api.ts';
	import type { Copy } from '../copy.ts';
	import { formatFullTimestamp } from './chat-view.ts';

	type Props = {
		control: WorkQuestionControl;
		botName: string;
		planName: string;
		ticketName: string | null;
		t: Copy;
		disabled?: boolean;
		readOnly?: boolean;
		onAnswer: (body: string) => Promise<WorkAnswerResult | ApiError>;
	};
	let { control, botName, planName, ticketName, t, disabled = false, readOnly = false, onAnswer }: Props = $props();
	let draft = $state('');
	let pending = $state(false);
	let error = $state<'failed' | 'unknown' | null>(null);
	// Receipt feedback only: the persisted message, not this result, owns the answer/body/time.
	let held = $state(false);

	async function submit(): Promise<void> {
		if (pending || disabled || readOnly || control.answer || !draft.trim()) return;
		pending = true;
		error = null;
		try {
			const result = await onAnswer(draft);
			if (result instanceof ApiError) {
				error = ['request_unknown', 'request_pending'].includes(result.code) ? 'unknown' : 'failed';
			} else {
				held = result.inbox_state === 'held';
			}
		} catch {
			error = 'failed';
		} finally {
			pending = false;
		}
	}
</script>

<section class="work-question-card" aria-label={t.workQuestion.title}>
	<div class="work-question-title">{t.workQuestion.title}</div>
	<div class="work-question-context">{t.workQuestion.context(botName, planName, ticketName)}</div>
	<div class="work-question-text">{control.question}</div>
	{#if control.answer}
		<div class="work-question-saved">
			<div class="work-question-answer-label">{t.workQuestion.answer}</div>
			<div class="work-question-answer">{control.answer.body}</div>
			<time datetime={control.answer.at}>{formatFullTimestamp(control.answer.at)}</time>
			<p class="work-question-note" role="status">{held ? t.workQuestion.held : t.workQuestion.saved}</p>
		</div>
	{:else if readOnly}
		<p class="work-question-note">{t.workQuestion.readOnly}</p>
	{:else}
		<p class="work-question-note">{t.workQuestion.hint}</p>
		<label class="work-question-answer-label">
			{t.workQuestion.answer}
			<textarea bind:value={draft} rows="3" disabled={disabled || pending} aria-label={t.workQuestion.answer}></textarea>
		</label>
		<button type="button" disabled={disabled || pending || !draft.trim()} aria-busy={pending ? 'true' : undefined} onclick={() => void submit()}>
			{pending ? t.workQuestion.saving : t.workQuestion.submit}
		</button>
		{#if error}
			<p class="work-question-error" role="alert">{error === 'unknown' ? t.workQuestion.unknown : t.workQuestion.failed}</p>
		{/if}
	{/if}
</section>

<style>
	.work-question-card { display: grid; gap: 8px; min-width: 0; width: 100%; text-align: start; color: var(--ink); }
	.work-question-title { font-size: var(--text-body); font-weight: 600; }
	.work-question-context, time { font-size: var(--text-caption); color: var(--muted); overflow-wrap: anywhere; }
	.work-question-text, .work-question-answer { white-space: pre-wrap; overflow-wrap: anywhere; font-size: var(--text-body); line-height: 1.6; }
	.work-question-answer-label { display: grid; gap: 6px; color: var(--ink-secondary); font-size: var(--text-caption); }
	.work-question-saved { display: grid; gap: 6px; border-top: 1px solid var(--line); padding-top: 10px; }
	.work-question-note, .work-question-error { margin: 0; font-size: var(--text-caption); line-height: 1.5; color: var(--muted); }
	.work-question-error { color: var(--danger-text); }
	textarea { width: 100%; min-width: 0; box-sizing: border-box; resize: vertical; padding: 8px 10px; border: 1px solid var(--line); border-radius: var(--radius-sm); color: var(--ink); background: var(--pane); font: inherit; font-size: var(--text-body); line-height: 1.5; }
	textarea:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
	button { justify-self: start; min-height: 32px; padding: 0 12px; border: 1px solid var(--accent-border); border-radius: var(--radius-sm); color: var(--accent); background: var(--accent-tint); cursor: pointer; font-size: var(--text-caption); font-weight: 500; }
	button:disabled, textarea:disabled { opacity: 0.6; cursor: default; }
	@media (pointer: coarse) { button { min-height: 44px; } }
</style>
