<script lang="ts">
	import { BOT_BUILTIN_MODEL_ROLES, type AgentsStatusResponse, type ClaudeCodeStatus, type Provider, type Settings, type SettingsPatch } from '@real-bot/protocol';
	import type { Copy } from '../copy.ts';
	import { BUILTIN_GROUPS, builtinModelsOf, builtinPatch } from './builtin-models.ts';
	import SideModelCard from './SideModelCard.svelte';

	/**
	 * Which model each call the app makes on its own runs on (ADR 0077), grouped by what it is for:
	 * reading your lines, organizing and checking, the composer, and the calls made as a Bot. Each is
	 * a picker of an endpoint's models, or a model of one of your local agents — Claude Code, Codex
	 * and the rest (ADR 0079) — or none to run as before. A daemon older than the ADR only has the
	 * reading and organizing models, and takes no agent model for the organizer.
	 */
	interface Props {
		providers: readonly Provider[];
		settings: Settings;
		/** The default endpoint's default model, named on the option that follows it. */
		defaultModel: string | null;
		patch: (patch: SettingsPatch) => Promise<unknown | null>;
		/** What the daemon finds of your Claude Code; absent or failing (the phone cannot ask), no Claude group is offered. */
		claudeCode?: (() => Promise<ClaudeCodeStatus>) | null;
		/** What the daemon finds of your other local agents; absent or failing, no agent group is offered. */
		agents?: (() => Promise<AgentsStatusResponse>) | null;
		t: Copy;
	}

	let { providers, settings, defaultModel, patch, claudeCode = null, agents = null, t }: Props = $props();

	const view = $derived(builtinModelsOf(settings));
	const groups = $derived(
		BUILTIN_GROUPS.map((group) => ({ ...group, roles: group.roles.filter((role) => view.roles.includes(role)) })).filter(
			(group) => group.roles.length > 0
		)
	);

	/** Every row asks for the Claude status on mount; the card asks the daemon once and hands them all the same answer. */
	let status: Promise<ClaudeCodeStatus> | null = null;
	const claudeStatusOnce = (): Promise<ClaudeCodeStatus> => (status ??= claudeCode!());
	/** The same for the other agents. */
	let found: Promise<AgentsStatusResponse> | null = null;
	const agentsOnce = (): Promise<AgentsStatusResponse> => (found ??= agents!());
</script>

<div class="builtin-models" data-builtin-models>
	{#each groups as group (group.key)}
		<section class="builtin-group" aria-label={t.builtinModels.groups[group.key].title} data-builtin-group={group.key}>
			<h3 class="builtin-group-title">{t.builtinModels.groups[group.key].title}</h3>
			<p class="builtin-hint">{t.builtinModels.groups[group.key].hint}</p>
			{#each group.roles as role (role)}
				{@const name = t.builtinModels.roles[role].name}
				<div class="builtin-row" data-builtin-role={role}>
					<div class="builtin-row-head">
						<span class="builtin-row-name">{name}</span>
						<p class="builtin-hint">{t.builtinModels.roles[role].hint}</p>
					</div>
					<SideModelCard
						framed={false}
						kind={role}
						{providers}
						chosen={view.chosen[role] ?? null}
						{defaultModel}
						{patch}
						toPatch={(next) => builtinPatch(role, next, view.legacy)}
						title={name}
						followDefault={BOT_BUILTIN_MODEL_ROLES.includes(role) ? () => t.builtinModels.followBot : t.builtinModels.followDefault}
						failed={t.builtinModels.failed}
						claude={(view.legacy && role === 'organizer') || !claudeCode ? null : { status: claudeStatusOnce, note: t.builtinModels.claudeNote }}
						agents={(view.legacy && role === 'organizer') || !agents ? null : agentsOnce}
						{t}
					/>
				</div>
			{/each}
		</section>
	{/each}
</div>

<style>
	.builtin-models {
		display: flex;
		flex-direction: column;
		gap: 14px;
		min-width: 0;
	}

	.builtin-group {
		display: flex;
		flex-direction: column;
		gap: 4px;
		padding: 12px 14px;
		background: var(--pane);
		border: 1px solid var(--line);
		border-radius: var(--radius-md);
		box-shadow: var(--shadow-xs);
		min-width: 0;
	}

	.builtin-group-title {
		margin: 0;
		font-size: 14px;
		font-weight: 600;
	}

	.builtin-hint {
		margin: 0;
		font-size: 12px;
		line-height: 1.45;
		color: var(--muted);
	}

	.builtin-row {
		display: flex;
		flex-direction: column;
		gap: 8px;
		margin-top: 10px;
		padding-top: 10px;
		border-top: 1px solid var(--line);
		min-width: 0;
	}

	.builtin-row-head {
		display: flex;
		flex-direction: column;
		gap: 2px;
	}

	.builtin-row-name {
		font-size: 13px;
		font-weight: 600;
	}

	@media (max-width: 720px) {
		.builtin-group {
			padding: 12px;
			box-shadow: none;
		}
	}
</style>
