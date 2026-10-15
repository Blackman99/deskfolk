<script lang="ts">
	import Icon from '../Icon.svelte';
	/**
	 * Where you pressed Always allow (ADR 0087): one row per rule, what it lets every Bot do and
	 * where, each one removable. A removed rule asks again on the next card there.
	 */
	import type { AllowRule } from '@real-bot/protocol';
	import SettingsCard from './SettingsCard.svelte';
	import SettingsCardHeader from './SettingsCardHeader.svelte';
	import type { Copy } from '../copy.ts';

	interface Props {
		rules: readonly AllowRule[];
		t: Copy;
		/** Rejects when the rule could not be removed. */
		onRemove: (id: string) => Promise<void>;
	}

	let { rules, t, onRemove }: Props = $props();

	let busy = $state<string | null>(null);
	let failed = $state<string | null>(null);

	async function remove(id: string): Promise<void> {
		if (busy) return;
		busy = id;
		failed = null;
		try {
			await onRemove(id);
		} catch {
			failed = id;
		} finally {
			busy = null;
		}
	}

	function kindLabel(kind: string): string {
		return t.settings.allowRuleKinds[kind as keyof typeof t.settings.allowRuleKinds] ?? kind;
	}
</script>

<SettingsCard class="settings-card-allow-rules">
	<SettingsCardHeader title={t.settings.allowRulesTitle} subtitle={t.settings.allowRulesSubtitle}>
		{#snippet icon()}
			<div class="settings-header-icon-wrap" aria-hidden="true">
				<Icon name="shield-check" />
			</div>
		{/snippet}
	</SettingsCardHeader>

	{#if rules.length === 0}
		<p class="muted allow-rules-empty">{t.settings.allowRulesEmpty}</p>
	{:else}
		<ul class="allow-rule-list" data-testid="allow-rules">
			{#each rules as rule (rule.id)}
				<li>
					<div class="allow-rule-copy">
						<span class="allow-rule-kind">{kindLabel(rule.kind_key)}</span>
						<span class="allow-rule-scope mono">{rule.scope === '*' ? t.settings.allowRuleAnywhere : rule.scope}</span>
						{#if failed === rule.id}
							<span class="field-error">{t.settings.allowRuleRemoveFailed}</span>
						{/if}
					</div>
					<button
						type="button"
						class="btn-xs"
						data-testid={`allow-rule-remove-${rule.id}`}
						disabled={busy !== null}
						onclick={() => void remove(rule.id)}>{t.settings.allowRuleRemove}</button
					>
				</li>
			{/each}
		</ul>
	{/if}
</SettingsCard>

<style>
	.settings-header-icon-wrap {
		width: 30px;
		height: 30px;
		border-radius: var(--radius-md);
		background: var(--accent-tint);
		color: var(--accent);
		display: flex;
		align-items: center;
		justify-content: center;
		flex-shrink: 0;
	}

	.allow-rules-empty {
		margin: 0;
		font-size: 13px;
	}

	.allow-rule-list {
		list-style: none;
		margin: 0;
		padding: 0;
		display: flex;
		flex-direction: column;
		gap: 8px;
	}

	.allow-rule-list li {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 12px;
		padding: 10px 12px;
		border: 1px solid var(--line);
		border-radius: var(--radius-md);
		background: var(--sidebar-bg);
	}

	.allow-rule-copy {
		min-width: 0;
		display: flex;
		flex-direction: column;
		gap: 2px;
	}

	.allow-rule-kind {
		font-size: 12px;
		font-weight: 600;
		color: var(--ink-secondary);
	}

	.allow-rule-scope {
		font-size: 12px;
		color: var(--ink);
		overflow-wrap: anywhere;
	}

	.allow-rule-list button {
		flex-shrink: 0;
	}
</style>
