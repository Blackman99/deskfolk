<script lang="ts">
	import type { Message } from '@real-bot/protocol';
	import type { Copy } from '../copy.ts';
	import type { AskDraftRecord } from '../notifications/types.ts';
	import { toggleAskChoice } from '../notifications/ask-state.ts';
	import { formatFullTimestamp, formatMessageTime } from './chat-view.ts';
	import {
		COMPOSER_IME_IDLE,
		composerImeKeyAction,
		composerImeOnEnd,
		composerImeOnStart,
		composerImeOnUpdate
	} from './composer-ime.ts';

	/**
	 * What sits under a Bot's question: the choices it offered, a line for your own answer, and —
	 * once you answered — what you chose and wrote, kept on the card. The answer is never posted as
	 * a message of yours; this card is where it stays.
	 */
	interface Props {
		message: Message;
		/** The turn is waiting on this very question, and this conversation lets you answer. */
		answerable: boolean;
		draft?: AskDraftRecord;
		sending?: boolean;
		t: Copy;
		onDraft: (body: string) => void;
		onSelect: (selected: string[]) => void;
		onSubmit: () => void;
	}

	let { message, answerable, draft, sending = false, t, onDraft, onSelect, onSubmit }: Props = $props();

	const options = $derived(message.ask?.options ?? []);
	const multi = $derived(Boolean(message.ask?.multi_select));
	const answer = $derived(message.ask_answer ?? null);
	const open = $derived(!answer && answerable);
	const selected = $derived(answer ? answer.selected : (draft?.selected ?? []));
	const body = $derived(draft?.body ?? '');
	const canSubmit = $derived(open && !sending && (selected.length > 0 || body.trim().length > 0));

	let ime = COMPOSER_IME_IDLE;

	function toggle(label: string): void {
		if (!open) return;
		onSelect(toggleAskChoice(options, multi, selected, label));
	}

	function submit(): void {
		if (canSubmit) onSubmit();
	}

	function onKeydown(ev: KeyboardEvent): void {
		if (ev.key !== 'Enter') return;
		const action = composerImeKeyAction(ev, ime, Date.now());
		if (action === 'ignore') return;
		ev.preventDefault();
		if (action === 'pass') submit();
	}
</script>

<div class="ask-card" class:is-open={open} class:is-answered={answer !== null}>
	{#if options.length > 0}
		{#if open}
			<div class="ask-mode">{multi ? t.stream.askPickAny : t.stream.askPickOne}</div>
		{/if}
		<div class="ask-options" role={multi ? 'group' : 'radiogroup'} aria-label={message.body}>
			{#each options as option (option.label)}
				{@const on = selected.includes(option.label)}
				<button
					type="button"
					class="ask-option"
					class:is-on={on}
					role={multi ? 'checkbox' : 'radio'}
					aria-checked={on}
					disabled={!open}
					onclick={() => toggle(option.label)}
				>
					<span class="ask-mark" class:is-radio={!multi} aria-hidden="true">
						{#if on}
							{#if multi}
								<svg viewBox="0 0 12 12" width="10" height="10">
									<path d="M2.5 6.2 5 8.6 9.5 3.6" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" />
								</svg>
							{:else}
								<span class="ask-dot"></span>
							{/if}
						{/if}
					</span>
					<span class="ask-option-text">
						<span class="ask-option-label">{option.label}</span>
						{#if option.description}
							<span class="ask-option-desc">{option.description}</span>
						{/if}
					</span>
				</button>
			{/each}
		</div>
	{/if}

	{#if answer}
		{#if answer.custom}
			<div class="ask-own">
				<div class="ask-own-text" aria-label={t.stream.askYourAnswer}>{answer.custom}</div>
			</div>
		{/if}
		<div class="ask-answered" title={formatFullTimestamp(answer.answered_at)}>
			{t.stream.askAnswered} · {formatMessageTime(answer.answered_at)}
		</div>
	{:else if open}
		<div class="ask-reply">
			<input
				type="text"
				placeholder={options.length > 0 ? t.stream.askWriteOwn : t.stream.reply}
				aria-label={options.length > 0 ? t.stream.askWriteOwn : t.stream.reply}
				value={body}
				oninput={(ev) => onDraft((ev.currentTarget as HTMLInputElement).value)}
				oncompositionstart={() => (ime = composerImeOnStart())}
				oncompositionupdate={() => (ime = composerImeOnUpdate(ime))}
				oncompositionend={() => (ime = composerImeOnEnd(Date.now()))}
				onkeydown={onKeydown}
			/>
			<button type="button" class="ask-send" disabled={!canSubmit} onclick={submit}>{t.stream.reply}</button>
		</div>
		{#if draft?.error}
			<p class="ask-error">{draft.error}</p>
		{/if}
	{:else}
		<div class="ask-ended">{t.notifications.askEndedReadOnly}</div>
	{/if}
</div>

<style>
	.ask-card {
		display: flex;
		flex-direction: column;
		gap: 8px;
		margin-top: 10px;
	}

	.ask-mode {
		font-size: 11.5px;
		font-weight: 600;
		color: var(--muted);
		letter-spacing: 0.02em;
	}

	.ask-options {
		display: flex;
		flex-direction: column;
		gap: 6px;
	}

	.ask-option {
		display: flex;
		align-items: flex-start;
		gap: 10px;
		width: 100%;
		min-height: 38px;
		padding: 8px 11px;
		border: 1px solid var(--line);
		border-radius: var(--radius-sm);
		background: var(--chip);
		color: var(--ink);
		text-align: left;
		font: inherit;
		cursor: pointer;
		transition: background 0.15s ease, border-color 0.15s ease, opacity 0.15s ease;
	}

	.ask-card.is-open .ask-option:hover {
		border-color: var(--accent-border);
		background: var(--input-bg);
	}

	.ask-option:focus-visible {
		outline: 2px solid var(--accent);
		outline-offset: 1px;
	}

	.ask-option.is-on {
		border-color: var(--accent);
		background: var(--accent-tint);
	}

	.ask-option:disabled {
		cursor: default;
	}

	/* A settled card keeps every choice readable; the ones not taken step back. */
	.ask-card:not(.is-open) .ask-option:not(.is-on) {
		opacity: 0.55;
	}

	.ask-mark {
		flex: none;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 16px;
		height: 16px;
		margin-top: 1px;
		border: 1.5px solid var(--line-hover);
		border-radius: 4px;
		background: var(--pane);
		color: #ffffff;
	}

	.ask-mark.is-radio {
		border-radius: 50%;
	}

	.ask-option.is-on .ask-mark {
		border-color: var(--accent);
		background: var(--accent);
	}

	.ask-option.is-on .ask-mark.is-radio {
		background: var(--pane);
	}

	.ask-dot {
		width: 8px;
		height: 8px;
		border-radius: 50%;
		background: var(--accent);
	}

	.ask-option-text {
		display: flex;
		flex-direction: column;
		gap: 2px;
		min-width: 0;
	}

	.ask-option-label {
		font-size: 13px;
		font-weight: 600;
		line-height: 1.35;
		overflow-wrap: anywhere;
	}

	.ask-option-desc {
		font-size: 12px;
		line-height: 1.4;
		color: var(--ink-secondary);
		overflow-wrap: anywhere;
	}

	/* Your own words sit in your colours, as if you had said them — on the card, not after it. */
	.ask-own {
		display: flex;
		justify-content: flex-end;
	}

	.ask-own-text {
		max-width: 88%;
		padding: 7px 11px;
		border-radius: var(--radius-md) var(--radius-md) 4px var(--radius-md);
		background: var(--you);
		color: var(--you-text);
		font-size: 13px;
		line-height: 1.45;
		white-space: pre-wrap;
		overflow-wrap: anywhere;
	}

	.ask-answered {
		align-self: flex-end;
		font-size: 11.5px;
		color: var(--muted);
	}

	.ask-reply {
		display: flex;
		gap: 8px;
		margin-top: 2px;
	}

	.ask-reply input {
		flex: 1;
		min-width: 0;
		border: 1px solid var(--line);
		border-radius: var(--radius-sm);
		padding: 7px 11px;
		background: var(--chip);
		color: var(--ink);
		font-size: 13px;
		transition: all 0.15s ease;
	}

	.ask-reply input:focus {
		background: var(--input-bg);
		border-color: var(--accent);
	}

	.ask-send {
		flex: none;
		background: var(--accent);
		color: #ffffff;
		border-radius: var(--radius-sm);
		padding: 7px 13px;
		font-weight: 600;
		font-size: 12.5px;
		box-shadow: var(--shadow-xs);
	}

	.ask-send:hover:not(:disabled) {
		background: var(--accent-hover);
	}

	.ask-send:disabled {
		opacity: 0.45;
		cursor: default;
		box-shadow: none;
	}

	.ask-error {
		margin: 0;
		font-size: 12px;
		color: var(--danger-text);
	}

	.ask-ended {
		font-size: 12px;
		color: var(--muted);
	}
</style>
