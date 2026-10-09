<script lang="ts">
	import type { Hold } from '@real-bot/protocol';
	import type { Copy } from '../copy.ts';
	import { formatFullTimestamp, formatMessageTime } from '../chat/chat-view.ts';

	/**
	 * Your stops in force, above the list (ADR 0040 P2): what each holds, since when, and a lift for
	 * each. Only while there is one, or while a stop or lift from the list was refused and says so;
	 * the list itself marks the conversations a stop holds.
	 */
	type Props = {
		holds: readonly Hold[];
		label: (hold: Hold) => string;
		t: Copy;
		disabled?: boolean;
		/** Resolves to a refusal to show on its row (an `ApiError`), or nothing. */
		onLift: (hold: Hold) => Promise<unknown> | void;
		/** 「全部停下」 or 「全部继续」 from the tools menu was refused. */
		failed?: boolean;
	};

	let { holds, label, t, disabled = false, onLift, failed = false }: Props = $props();
	let lifting = $state<string | null>(null);
	/** The stop whose lift was refused, said on its row until you try again. */
	let liftFailed = $state<string | null>(null);

	async function lift(hold: Hold): Promise<void> {
		lifting = hold.id;
		liftFailed = null;
		try {
			if (await onLift(hold)) liftFailed = hold.id;
		} catch {
			liftFailed = hold.id;
		} finally {
			lifting = null;
		}
	}
</script>

{#if holds.length > 0 || failed}
	<section class="holds" aria-label={t.control.holdsTitle}>
		{#if failed}
			<p class="holds-error holds-failed" role="status">{t.control.failed}</p>
		{/if}
		{#if holds.length > 0}
			<div class="holds-head">
				<svg aria-hidden="true" width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="5" width="4" height="14" rx="1"></rect><rect x="14" y="5" width="4" height="14" rx="1"></rect></svg>
				<span>{t.control.holdsTitle}</span>
				<span class="holds-count">{holds.length}</span>
			</div>
			<ul class="holds-list">
				{#each holds as hold (hold.id)}
					<li class="holds-row" title={hold.lift_on_next_user_message ? t.control.liftOnNext : formatFullTimestamp(hold.created_at)}>
						<span class="holds-label" title={label(hold)}>{label(hold)}</span>
						{#if hold.action === 'cancel'}
							<span class="holds-tag">{t.control.dropped}</span>
						{/if}
						{#if liftFailed === hold.id}
							<span class="holds-error" role="status">{t.control.failed}</span>
						{:else}
							<span class="holds-time mono">{formatMessageTime(hold.created_at)}</span>
						{/if}
						<button
							type="button"
							class="holds-lift"
							disabled={disabled || lifting === hold.id}
							onclick={() => void lift(hold)}
						>
							{t.control.lift}
						</button>
					</li>
				{/each}
			</ul>
		{/if}
	</section>
{/if}

<style>
	.holds {
		margin: 4px 8px 6px;
		padding: 6px 8px;
		border: 1px solid var(--line);
		border-radius: var(--radius-md);
		background: var(--line-subtle);
	}

	.holds-head {
		display: flex;
		align-items: center;
		gap: 6px;
		font-size: var(--text-caption);
		font-weight: 600;
		color: var(--ink-secondary);
	}

	.holds-count {
		color: var(--muted);
		font-weight: 500;
	}

	.holds-list {
		display: flex;
		flex-direction: column;
		gap: 2px;
		max-height: 132px;
		margin: 4px 0 0;
		padding: 0;
		overflow-y: auto;
		list-style: none;
	}

	.holds-row {
		display: flex;
		align-items: center;
		gap: 6px;
		min-height: 26px;
		font-size: var(--text-caption);
		color: var(--ink);
	}

	.holds-label {
		flex: 1 1 auto;
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.holds-tag {
		flex-shrink: 0;
		padding: 0 5px;
		border-radius: var(--radius-xs);
		background: var(--chip);
		color: var(--ink-secondary);
		font-size: var(--text-micro);
	}

	.holds-time {
		flex-shrink: 0;
		color: var(--muted);
		font-size: var(--text-micro);
	}

	.holds-error {
		flex-shrink: 0;
		margin: 0;
		color: var(--danger-text);
		font-size: var(--text-micro);
	}

	.holds-failed + .holds-head {
		margin-top: 4px;
	}

	.holds-lift {
		flex-shrink: 0;
		height: 22px;
		padding: 0 8px;
		font-size: var(--text-micro);
		font-weight: 500;
		color: var(--accent);
		background: var(--pane);
		border: 1px solid var(--accent-border);
		border-radius: var(--radius-sm);
		cursor: pointer;
		transition: 0.15s ease;
		transition-property: var(--transition-props);
	}

	.holds-lift:hover:not(:disabled) {
		color: var(--on-accent);
		background: var(--accent);
		border-color: var(--accent);
	}

	.holds-lift:disabled {
		opacity: 0.5;
		cursor: default;
	}

	@media (pointer: coarse) {
		.holds-row {
			min-height: 40px;
		}

		.holds-lift {
			height: 32px;
			padding: 0 12px;
		}
	}
</style>
