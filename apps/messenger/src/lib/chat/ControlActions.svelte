<script lang="ts">
	import type { ControlOffer, Hold, MessageControl } from '@real-bot/protocol';
	import type { Copy } from '../copy.ts';
	import NewPlanActions from './NewPlanActions.svelte';
	import { controlBar, partialOf, type ControlButton, type RestartPartial } from './control-actions.ts';

	/**
	 * The buttons under a line about your stops: the app's receipt or status answer, or your own line
	 * it marked as maybe meaning a stop. What they show is read from the line and the stops in force
	 * (`control-actions.ts`); a press goes to the daemon, and the line's own `acted` then says what
	 * was done — nothing here remembers it.
	 */
	type Props = {
		control: MessageControl | undefined;
		holds: readonly Hold[];
		botName: (id: string) => string;
		t: Copy;
		/** Under your own line the row sits on its right, as the line does. */
		align?: 'start' | 'end';
		disabled?: boolean;
		/**
		 * Makes the press. Resolves to a refusal to show, `{ partial }` for a restart notice's 继续
		 * that a stop of yours kept from some of its turns, or nothing. `note`: what you wrote in the
		 * box a button asks it in (退回 on a hand-over), when you wrote anything.
		 */
		onAct: (action: ControlOffer, taskId?: string, note?: string) => Promise<unknown>;
	};

	let { control, holds, botName, t, align = 'start', disabled = false, onAct }: Props = $props();

	const bar = $derived(controlBar(control, holds, { bot: botName }, t.control));
	let pending = $state<ControlButton | null>(null);
	let failed = $state(false);
	/** Some of the notice's turns went on, the rest a stop holds: said until the stops change or the next press. */
	let partial = $state<(RestartPartial & { over: string }) | null>(null);
	const holdsNow = $derived(holds.map((hold) => hold.id).join(' '));
	$effect.pre(() => {
		if (partial && partial.over !== holdsNow) partial = null;
	});

	/**
	 * A button that asks what you want changed first (退回 on a hand-over): its box under the row,
	 * and what you have written in it. It said nothing before, and the Bot it went back to was told
	 * only that you sent it back (2026-10-04).
	 */
	let asking = $state<ControlButton | null>(null);
	let noteText = $state('');
	let noteBox = $state<HTMLTextAreaElement | null>(null);

	function ask(button: ControlButton): void {
		if (pending || disabled) return;
		asking = button;
		failed = false;
		void Promise.resolve().then(() => noteBox?.focus());
	}

	function onNoteKey(event: KeyboardEvent): void {
		if (event.key === 'Escape') {
			event.preventDefault();
			asking = null;
		} else if (event.key === 'Enter' && (event.metaKey || event.ctrlKey) && asking) {
			event.preventDefault();
			void press(asking, noteText);
		}
	}

	async function press(button: ControlButton, note?: string): Promise<void> {
		if (pending || disabled) return;
		if (button.note && note === undefined) return ask(button);
		pending = button;
		failed = false;
		partial = null;
		const over = holdsNow;
		try {
			// A refusal comes back as a value; the row stays so it can be pressed again.
			const said = note?.trim();
			const answer = said ? await onAct(button.action, button.taskId, said) : await onAct(button.action, button.taskId);
			const some = partialOf(answer);
			if (some) partial = { ...some, over };
			else failed = Boolean(answer);
			if (!failed) asking = null;
		} catch {
			failed = true;
		} finally {
			pending = null;
		}
	}
</script>

{#if control?.kind === 'plan_opened'}
	<NewPlanActions {control} {t} {disabled} {onAct} />
{:else if bar.state === 'ask'}
	<div class="control-actions" class:is-end={align === 'end'} role="group" aria-label={t.control.menu}>
		{#if bar.prompt}
			<span class="control-prompt">{bar.prompt}</span>
		{/if}
		{#each bar.buttons as button (`${button.action}:${button.taskId ?? ''}`)}
			<button
				type="button"
				class="control-btn"
				class:is-primary={button.primary}
				disabled={disabled || pending !== null}
				aria-busy={pending === button ? 'true' : undefined}
				onmousedown={(e) => e.stopPropagation()}
				onclick={() => void press(button)}
			>
				{button.label}
			</button>
		{/each}
		{#if asking}
			<div class="control-note-form">
				<textarea
					bind:this={noteBox}
					bind:value={noteText}
					class="control-note-input"
					rows="2"
					maxlength="2000"
					placeholder={t.control.sendBackNote}
					aria-label={t.control.sendBackNote}
					disabled={disabled || pending !== null}
					onkeydown={onNoteKey}
					onmousedown={(e) => e.stopPropagation()}
				></textarea>
				<div class="control-note-actions">
					<button
						type="button"
						class="control-btn is-primary"
						disabled={disabled || pending !== null}
						aria-busy={pending === asking ? 'true' : undefined}
						onmousedown={(e) => e.stopPropagation()}
						onclick={() => asking && void press(asking, noteText)}
					>{t.control.sendBackConfirm}</button>
					<button
						type="button"
						class="control-btn"
						disabled={pending !== null}
						onmousedown={(e) => e.stopPropagation()}
						onclick={() => (asking = null)}
					>{t.control.sendBackCancel}</button>
				</div>
			</div>
		{/if}
		{#if failed}
			<span class="control-error" role="status">{t.control.failed}</span>
		{:else if partial}
			<span class="control-note" role="status">{t.control.partlyResumed(partial.continued, partial.held)}</span>
		{/if}
	</div>
{:else if bar.state === 'done'}
	<div class="control-actions is-done" class:is-end={align === 'end'}>
		<span class="control-done">{bar.note}</span>
	</div>
{/if}

<style>
	.control-actions {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 6px;
		margin-top: 6px;
	}

	.control-actions.is-end {
		justify-content: flex-end;
	}

	.control-prompt,
	.control-done,
	.control-note {
		font-size: var(--text-caption);
		color: var(--muted);
	}

	.control-note-form {
		display: flex;
		flex-direction: column;
		gap: 6px;
		flex-basis: 100%;
		max-width: 420px;
	}

	.control-note-input {
		width: 100%;
		min-height: 52px;
		padding: 6px 8px;
		font: inherit;
		font-size: var(--text-caption);
		color: var(--ink);
		background: var(--pane);
		border: 1px solid var(--line);
		border-radius: var(--radius-sm);
		resize: vertical;
	}

	.control-note-input:focus {
		outline: none;
		border-color: var(--accent-border);
	}

	.control-note-actions {
		display: flex;
		gap: 6px;
	}

	.control-error {
		font-size: var(--text-caption);
		color: var(--danger-text);
	}

	.control-btn {
		height: 28px;
		padding: 0 10px;
		font-size: var(--text-caption);
		font-weight: 500;
		color: var(--ink-secondary);
		background: var(--pane);
		border: 1px solid var(--line);
		border-radius: var(--radius-sm);
		cursor: pointer;
		user-select: none;
		transition: 0.15s ease;
		transition-property: var(--transition-props);
	}

	.control-btn:hover:not(:disabled) {
		color: var(--accent);
		border-color: var(--accent-border);
	}

	.control-btn.is-primary {
		color: var(--accent);
		background: var(--accent-tint);
		border-color: var(--accent-border);
	}

	.control-btn.is-primary:hover:not(:disabled) {
		color: var(--on-accent);
		background: var(--accent);
		border-color: var(--accent);
	}

	.control-btn:disabled {
		opacity: 0.5;
		cursor: default;
	}

	/* A thumb, not a pointer: the same row, taller targets. */
	@media (pointer: coarse) {
		.control-btn {
			height: 36px;
			padding: 0 12px;
		}
	}
</style>
