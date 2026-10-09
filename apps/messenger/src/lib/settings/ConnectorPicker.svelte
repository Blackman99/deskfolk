<script lang="ts">
	import { CONNECTORS, type ConnectorId } from '@real-bot/protocol';
	import ConnectorLogo from './ConnectorLogo.svelte';
	import type { Copy } from '../copy.ts';

	type Props = {
		t: Copy;
		/** A built-in connector, or null for a custom endpoint. */
		onpick: (id: ConnectorId | null) => void;
	};

	let { t, onpick }: Props = $props();
</script>

<p class="muted connector-pick-hint">{t.connectors.pickHint}</p>
<div class="connector-pick-grid">
	{#each CONNECTORS as connector (connector.id)}
		<button type="button" class="connector-pick" onclick={() => onpick(connector.id)}>
			<ConnectorLogo id={connector.id} size={40} />
			<span class="connector-pick-text">
				<span class="connector-pick-name">{t.connectors.name[connector.id]}</span>
				<span class="connector-pick-blurb">{t.connectors.blurb[connector.id]}</span>
			</span>
		</button>
	{/each}
	<button type="button" class="connector-pick is-custom" onclick={() => onpick(null)}>
		<span class="connector-pick-custom-mark" aria-hidden="true">
			<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"></path><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"></path></svg>
		</span>
		<span class="connector-pick-text">
			<span class="connector-pick-name">{t.connectors.custom}</span>
			<span class="connector-pick-blurb">{t.connectors.customBlurb}</span>
		</span>
	</button>
</div>

<style>
	.connector-pick-hint {
		margin: 0 0 14px;
		font-size: 13px;
		line-height: 1.6;
	}

	.connector-pick-grid {
		display: grid;
		grid-template-columns: repeat(2, minmax(0, 1fr));
		gap: 10px;
	}

	.connector-pick {
		display: flex;
		align-items: center;
		gap: 12px;
		min-width: 0;
		padding: 12px;
		border: 1px solid var(--line);
		border-radius: var(--radius-md);
		background: var(--pane);
		color: var(--ink);
		text-align: left;
		cursor: pointer;
		transition: 0.15s ease;
		transition-property: var(--transition-props);
	}

	.connector-pick:hover {
		border-color: var(--accent-border);
		background: var(--accent-tint);
	}

	.connector-pick:focus-visible {
		outline: 2px solid var(--accent);
		outline-offset: 2px;
	}

	.connector-pick-text {
		display: flex;
		flex-direction: column;
		gap: 3px;
		min-width: 0;
	}

	.connector-pick-name {
		font-size: 14px;
		font-weight: 600;
		line-height: 1.3;
	}

	.connector-pick-blurb {
		font-size: 12px;
		line-height: 1.45;
		color: var(--muted);
	}

	.connector-pick-custom-mark {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		flex: 0 0 auto;
		width: 40px;
		height: 40px;
		box-sizing: border-box;
		border-radius: var(--radius-sm);
		border: 1.5px dashed var(--line);
		color: var(--accent);
	}

	@media (max-width: 720px) {
		.connector-pick-grid {
			grid-template-columns: minmax(0, 1fr);
		}

		.connector-pick {
			min-height: 64px;
		}

		.connector-pick-name {
			font-size: 15px;
		}

		.connector-pick-blurb {
			font-size: 13px;
		}
	}
</style>
