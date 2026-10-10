<script lang="ts">
	import {
		BOT_BUILTIN_MODEL_ROLES,
		type AgentsStatusResponse,
		type BuiltinModelRole,
		type ClaudeCodeStatus,
		type Locale,
		type PromptSummary,
		type Provider,
		type Settings,
		type SettingsPatch
	} from '@real-bot/protocol';
	import type { Copy } from '../copy.ts';
	import PromptRowList from './PromptRowList.svelte';
	import SideModelCard from './SideModelCard.svelte';
	import { builtinModelsOf, builtinPatch } from './builtin-models.ts';
	import type { RoutingNodeView } from './routing-map.ts';

	/**
	 * One of the app's own calls on Settings › Roles (ADR 0082): what it does, the model it runs on
	 * (ADR 0077) — an endpoint's, one of your local agents' (ADR 0079), or none to run as before — and
	 * the prompts it runs with (ADR 0064), each opening in the prompt editor.
	 */
	interface Props {
		role: BuiltinModelRole;
		view: RoutingNodeView;
		providers: readonly Provider[];
		settings: Settings;
		/** The default endpoint's default model, named on the option that follows it. */
		defaultModel: string | null;
		patch: (patch: SettingsPatch) => Promise<unknown | null>;
		/** A model can be picked: there is an endpoint, or setup was done on a local agent (ADR 0078). */
		pickable: boolean;
		/** What the daemon finds of your Claude Code, asked once for the page; null offers no Claude model. */
		claudeStatus: (() => Promise<ClaudeCodeStatus>) | null;
		/** The same for your other local agents. */
		agents: (() => Promise<AgentsStatusResponse>) | null;
		promptsFailed: boolean;
		ui: Locale;
		botNames: ReadonlyMap<string, string>;
		onopenprompt: (item: PromptSummary, event: MouseEvent) => void;
		t: Copy;
	}

	let { role, view, providers, settings, defaultModel, patch, pickable, claudeStatus, agents, promptsFailed, ui, botNames, onopenprompt, t }: Props = $props();
	const c = $derived(t.routing);
	const name = $derived(t.builtinModels.roles[role].name);
	const legacy = $derived(builtinModelsOf(settings).legacy);
	// An older daemon runs the organizer on an endpoint's model only.
	const offersAgents = $derived(!(legacy && role === 'organizer'));
</script>

<section class="routing-detail" aria-label={name} data-routing-detail={role}>
	<div class="routing-detail-head">
		<h3 class="routing-detail-name">{name}</h3>
		<p class="routing-hint">{t.builtinModels.roles[role].hint}</p>
	</div>

	<div class="routing-detail-part" data-routing-part="model">
		<h4 class="routing-part-title">{c.model}</h4>
		{#if !view.choosable}
			<p class="routing-hint">{c.older}</p>
		{:else if !pickable}
			<p class="routing-hint">{c.noEndpoint}</p>
		{:else}
			<SideModelCard
				framed={false}
				kind={role}
				{providers}
				chosen={builtinModelsOf(settings).chosen[role] ?? null}
				{defaultModel}
				{patch}
				toPatch={(next) => builtinPatch(role, next, legacy)}
				title={name}
				followDefault={BOT_BUILTIN_MODEL_ROLES.includes(role) ? () => t.builtinModels.followBot : t.builtinModels.followDefault}
				failed={t.builtinModels.failed}
				claude={offersAgents && claudeStatus ? { status: claudeStatus, note: t.builtinModels.claudeNote } : null}
				agents={offersAgents ? agents : null}
				{t}
			/>
		{/if}
	</div>

	<div class="routing-detail-part" data-routing-part="prompts">
		<h4 class="routing-part-title">{c.prompts}</h4>
		{#if view.prompts.length > 0}
			<PromptRowList items={view.prompts} {ui} {botNames} {t} onopen={onopenprompt} stacked />
		{:else if promptsFailed}
			<p class="field-error" role="alert">{c.promptsLoadFailed}</p>
		{:else}
			<p class="routing-hint">{c.noPrompts}</p>
		{/if}
	</div>
</section>

<style>
	.routing-detail {
		display: flex;
		flex-direction: column;
		gap: 14px;
		padding: 14px;
		border: 1px solid var(--line);
		border-radius: var(--radius-md);
		background: var(--pane);
		box-shadow: var(--shadow-xs);
		min-width: 0;
	}

	.routing-detail-head {
		display: flex;
		flex-direction: column;
		gap: 3px;
	}

	.routing-detail-name {
		margin: 0;
		font-size: 14px;
		font-weight: 600;
	}

	.routing-hint {
		margin: 0;
		font-size: 12px;
		line-height: 1.45;
		color: var(--muted);
	}

	.routing-detail-part {
		display: flex;
		flex-direction: column;
		gap: 8px;
		padding-top: 12px;
		border-top: 1px solid var(--line);
		min-width: 0;
	}

	.routing-part-title {
		margin: 0;
		font-size: 12px;
		font-weight: 600;
		color: var(--ink-secondary);
	}

	@media (max-width: 720px) {
		.routing-detail {
			padding: 12px;
			box-shadow: none;
		}

		/* The page's head names the call already. */
		.routing-detail-name {
			display: none;
		}
	}
</style>
