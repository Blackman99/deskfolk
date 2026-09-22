<script lang="ts">
	import type { Copy } from './copy.ts';
	import type { BuildUpdates } from './build-version.svelte.ts';

	let { t, updates }: { t: Copy; updates: BuildUpdates } = $props();
</script>

<!--
	A new build is worth a line, not a takeover: nobody wants the page swapped mid-sentence. It
	rides above whatever sits at the bottom of the screen, and it can be waved off — during a run
	of deploys the same offer should not keep asking.
-->
{#if updates.offered}
	<div class="build-update" role="status" data-testid="build-update">
		<span class="build-update-dot" aria-hidden="true"></span>
		<span class="build-update-text">{t.common.updateReady}</span>
		<button type="button" class="build-update-reload" onclick={() => location.reload()}>
			{t.common.updateReload}
		</button>
		<button
			type="button"
			class="build-update-dismiss"
			aria-label={t.common.close}
			data-testid="build-update-dismiss"
			onclick={() => updates.dismiss()}
		>
			<svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true">
				<path d="m3.5 3.5 7 7M10.5 3.5l-7 7" />
			</svg>
		</button>
	</div>
{/if}

<style>
	.build-update {
		position: fixed;
		/* Centred by the gutters rather than by `left: 50%`: a fixed box positioned from one edge
		   shrinks to the space left of that edge, which cuts the line short on a phone. */
		inset-inline: 16px;
		bottom: max(16px, env(safe-area-inset-bottom));
		width: fit-content;
		margin-inline: auto;
		/* Above the page, below the modal layer (100): a dialog in front keeps the foreground. */
		z-index: 95;
		display: flex;
		align-items: center;
		gap: 10px;
		padding: 6px 6px 6px 14px;
		border: 1px solid var(--line);
		border-radius: 9999px;
		background: var(--pane);
		color: var(--ink);
		box-shadow: var(--shadow-lg);
		animation: buildUpdateRise 0.22s cubic-bezier(0.16, 1, 0.3, 1);
	}

	@keyframes buildUpdateRise {
		from {
			opacity: 0;
			transform: translateY(10px);
		}
		to {
			opacity: 1;
			transform: none;
		}
	}

	.build-update-dot {
		flex: none;
		width: 7px;
		height: 7px;
		border-radius: 50%;
		background: var(--accent);
		box-shadow: 0 0 0 3px var(--accent-glow);
	}

	.build-update-text {
		overflow: hidden;
		white-space: nowrap;
		text-overflow: ellipsis;
		font: 550 13px/1.2 var(--font);
	}

	.build-update-reload {
		flex: none;
		min-height: 30px;
		padding: 0 14px;
		border: 0;
		border-radius: 9999px;
		background: var(--accent);
		color: #fff;
		font: 600 12.5px/1 var(--font);
		cursor: pointer;
	}

	.build-update-reload:hover {
		background: var(--accent-hover);
	}

	.build-update-dismiss {
		flex: none;
		display: flex;
		align-items: center;
		justify-content: center;
		width: 30px;
		height: 30px;
		border: 0;
		border-radius: 50%;
		background: transparent;
		color: var(--muted);
		cursor: pointer;
	}

	.build-update-dismiss:hover {
		background: var(--row-hover);
		color: var(--ink);
	}

	.build-update-reload:focus-visible,
	.build-update-dismiss:focus-visible {
		outline: 2px solid var(--accent);
		outline-offset: 2px;
	}

	@media (max-width: 680px) {
		/* Clear of the navigation bar — the same 60px the shell reserves for it in Shell.svelte —
		   and of the composer on the screens that show one instead. */
		.build-update {
			bottom: calc(72px + env(safe-area-inset-bottom));
			gap: 8px;
			padding: 4px 4px 4px 14px;
		}

		/* Thumb targets, not pointer targets: 44×44 like the rest of the phone layout. */
		.build-update-reload {
			min-height: 44px;
			padding: 0 18px;
			font-size: 13px;
		}

		.build-update-dismiss {
			width: 44px;
			height: 44px;
		}
	}

	@media (prefers-reduced-motion: reduce) {
		.build-update {
			animation: none;
		}
	}
</style>
