<script lang="ts">
	import { isWorkspaceId } from '@real-bot/protocol';
	import type { Copy } from '../copy.ts';

	type Props = {
		id: string;
		value: string;
		invalid: boolean;
		t: Copy;
		oninput: (value: string) => void;
	};

	let { id, value, invalid, t, oninput }: Props = $props();
	/** Said as it is typed, not only when a save is refused. */
	const malformed = $derived(value.trim().length > 0 && !isWorkspaceId(value.trim()));
</script>

<!-- Anthropic's workspace for a key not scoped to one (ADR 0072). -->
<div class="modal-section workspace-field">
	<div class="field-head-row">
		<label for={id}>{t.connectors.workspace}</label>
		<span class="workspace-optional">{t.connectors.workspaceOptional}</span>
	</div>
	<input
		{id}
		type="text"
		class="mono"
		autocapitalize="off"
		autocorrect="off"
		spellcheck="false"
		placeholder="wrkspc_…"
		{value}
		oninput={(ev) => oninput((ev.currentTarget as HTMLInputElement).value)}
	/>
	{#if invalid || malformed}
		<p class="field-error">{t.connectors.workspaceInvalid}</p>
	{:else}
		<p class="muted field-hint">{t.connectors.workspaceHint}</p>
	{/if}
</div>

<style>
	.workspace-optional {
		font-size: 11px;
		color: var(--muted);
	}

	@media (max-width: 720px) {
		.workspace-field > input {
			min-height: 48px;
			font-size: 16px;
		}

		.workspace-field label {
			font-size: 14px;
		}
	}
</style>
