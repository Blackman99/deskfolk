<script lang="ts">
	import type { SessionSummary } from '@real-bot/protocol';
	import { untrack } from 'svelte';
	import SessionAvatar from '../SessionAvatar.svelte';
	import type { Copy } from '../copy.ts';
	import type { MessengerRuntime } from '../runtime.svelte.ts';
	import { presentBotIds } from '../sidebar/session-groups.ts';
	import { botWorkStatus } from '../sidebar/session-status.ts';
	import { groupNameCommit, mapGroupEditError, type GroupDetailDraft } from './group-edit.ts';

	type Props = {
		runtime: MessengerRuntime;
		session: SessionSummary;
		detail: GroupDetailDraft;
		t: Copy;
	};

	let { runtime, session, detail = $bindable(), t }: Props = $props();

	const snapshot = $derived(runtime.snapshot);
	const botsById = $derived(new Map(snapshot.bots.map((bot) => [bot.id, bot] as const)));
	const present = $derived(presentBotIds(session));
	const statusLabels = $derived({
		running: t.sidebar.statusRunning,
		replying: t.sidebar.statusReplying,
		waitingApproval: t.sidebar.statusWaitingApproval,
		waitingAsk: t.sidebar.statusWaitingAsk,
		failed: t.sidebar.statusFailed,
		interrupted: t.sidebar.statusInterrupted,
		idle: t.sidebar.statusIdle
	});

	// The last name the server has, so leaving the field does not send a name that is already saved.
	let savedName = untrack(() => (session.name ?? '').trim());
	let seenSession: string | null = null;
	let nameSaving = false;
	let nameSaveQueued = false;
	let nameFailed = $state(false);
	let mounted = true;

	$effect(() => {
		const id = session.id;
		const next = (session.name ?? '').trim();
		if (seenSession === id) return;
		seenSession = id;
		savedName = next;
		nameFailed = false;
	});

	// Closing the panel unmounts this field; a name still being typed goes out with it.
	$effect(() => () => {
		mounted = false;
		void commitGroupName();
	});

	function botStatusOf(botId: string) {
		return botWorkStatus(
			botId,
			snapshot.turns,
			snapshot.approvals,
			statusLabels,
			snapshot.pendingJudgements
		);
	}

	function onNameInput(): void {
		detail.nameError = undefined;
		nameFailed = false;
	}

	async function commitGroupName(): Promise<void> {
		if (session.kind !== 'group') return;
		if (nameSaving) {
			nameSaveQueued = true;
			return;
		}
		const sessionId = session.id;
		const decision = groupNameCommit(detail.name, savedName);
		if (decision.action === 'invalid') {
			if (mounted && detail.sessionId === sessionId) detail.nameError = 'empty';
			return;
		}
		if (decision.action === 'noop') {
			if (mounted && detail.sessionId === sessionId) {
				detail.name = savedName;
				detail.nameError = undefined;
			}
			return;
		}
		const sent = decision.name;
		nameSaving = true;
		if (mounted) {
			detail.nameError = undefined;
			nameFailed = false;
		}
		const error = await runtime.patchSession(sessionId, { name: sent });
		nameSaving = false;
		if (!error) {
			savedName = sent;
			if (detail.sessionId === sessionId) detail.name = sent;
		} else if (mounted && detail.sessionId === sessionId) {
			const mapped = mapGroupEditError(error.message);
			if ('name' in mapped) detail.nameError = mapped.name;
			else nameFailed = true;
		}
		if (nameSaveQueued) {
			nameSaveQueued = false;
			void commitGroupName();
		}
	}
</script>

<div class="group-identity">
	<div class="group-identity-avatar" aria-hidden="true">
		<SessionAvatar {session} bots={botsById} size="top" botStatus={botStatusOf} />
	</div>
	<div class="group-identity-copy">
		<input
			id="detail-group-name"
			class="group-identity-name"
			type="text"
			aria-label={t.sidebar.groupName}
			autocomplete="off"
			bind:value={detail.name}
			placeholder={t.sidebar.groupName}
			oninput={onNameInput}
			onblur={() => void commitGroupName()}
			onkeydown={(event) => {
				if (event.key !== 'Enter' || event.isComposing) return;
				event.preventDefault();
				void commitGroupName();
				(event.currentTarget as HTMLInputElement).blur();
			}}
		/>
		{#if detail.nameError}
			<p class="field-error">{t.sidebar.groupNameEmpty}</p>
		{:else if nameFailed}
			<p class="field-error">{t.detail.saveFailed}</p>
		{/if}
		<span class="group-identity-meta">
			<span>{present.length + 1} {t.detail.members}</span>
			{#if session.archived_at}
				<span class="badge-archived">{t.top.archived}</span>
			{/if}
		</span>
	</div>
</div>

<style>
	.group-identity {
		display: flex;
		align-items: center;
		gap: 12px;
		flex: 1;
		min-width: 0;
	}

	.group-identity-avatar {
		width: 36px;
		height: 36px;
		flex-shrink: 0;
		display: flex;
		align-items: center;
		justify-content: center;
	}

	.group-identity-avatar :global(.row-avatar) {
		--avatar-ring: var(--pane);
	}

	.group-identity-copy {
		flex: 1;
		min-width: 0;
		display: flex;
		flex-direction: column;
		gap: 1px;
	}

	/*
	 * The drawer styles every text field as a boxed control. This one is the panel's title, so
	 * those rules have to lose: transparent until it is hovered or focused.
	 */
	:global(.sheet) .group-identity-name {
		width: 100%;
		min-width: 0;
		margin: 0;
		padding: 1px 4px;
		border: 1px solid transparent;
		border-radius: var(--radius-sm);
		background: transparent;
		box-shadow: none;
		color: var(--ink);
		font: 700 15px/1.3 var(--font);
		letter-spacing: -0.01em;
	}

	:global(.sheet) .group-identity-name:hover {
		border-color: var(--line);
		background: var(--input-bg);
	}

	:global(.sheet) .group-identity-name:focus {
		border-color: var(--accent);
		background: var(--input-bg);
		box-shadow: 0 0 0 3px var(--accent-glow);
		outline: none;
	}

	.group-identity-meta {
		display: flex;
		align-items: center;
		gap: 6px;
		min-width: 0;
		padding-left: 4px;
		font-size: 12px;
		font-weight: 500;
		color: var(--muted);
	}

	.badge-archived {
		font-size: 10.5px;
		font-weight: 600;
		padding: 1px 6px;
		border-radius: 999px;
		background: var(--warn-bg);
		color: var(--warn-text);
		border: 1px solid var(--warn-line);
	}
</style>
