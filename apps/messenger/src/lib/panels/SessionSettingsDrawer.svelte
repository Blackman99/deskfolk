<script lang="ts">
	import type { Bot, SessionSummary } from '@real-bot/protocol';
	import type { backdropClick } from '../click-outside.ts';
	import type { Copy } from '../copy.ts';
	import type { ShellDangerConfirm } from '../overlays/danger-confirm.svelte.ts';
	import type { MessengerRuntime } from '../runtime.svelte.ts';
	import { classifySession, youBotPeer, type SessionGroup } from '../sidebar/session-groups.ts';
	import type { GroupDetailDraft } from './group-edit.ts';
	import GroupPane from './GroupPane.svelte';
	import ProfilePane from './ProfilePane.svelte';
	import SettingsHead from './SettingsHead.svelte';

	/**
	 * A conversation's settings, in either of the two places they open: beside the conversation in
	 * its workbench pane (`beside`), or as the drawer over the shell (and the page on a phone). Both
	 * are the same sheet with the same head and panes, so they share one set of styles. The state
	 * they run on — the unsaved group draft, which danger confirm is armed, which section a phone
	 * shows, the open profile pane — is the shell's, bound through here.
	 */
	type Props = {
		runtime: MessengerRuntime;
		t: Copy;
		narrow: boolean;
		botsById: ReadonlyMap<string, Bot>;
		sessionsById: ReadonlyMap<string, SessionSummary>;
		danger: ShellDangerConfirm;
		openProfile: (botId: string, sessionId?: string) => void;
		/** Settings beside this conversation on the workbench, for this Bot when one is named. Null for the drawer. */
		beside: { sessionId: string; botId: string | null } | null;
		closePaneSide: (sessionId: string) => void;
		selected: SessionSummary | null;
		selectedKind: SessionGroup | null;
		nestedProfile: boolean;
		profileBot: Bot | null;
		profileBackdrop: ReturnType<typeof backdropClick>;
		closeNestedProfile: () => void;
		closeCurrentDrawerScreen: () => void;
		profilePane: { backFromEditor: () => boolean } | undefined;
		profileFailed: boolean;
		paneMobileDetail: boolean;
		groupDetail: GroupDetailDraft;
	};

	let {
		runtime,
		t,
		narrow,
		botsById,
		sessionsById,
		danger,
		openProfile,
		beside,
		closePaneSide,
		selected,
		selectedKind,
		nestedProfile,
		profileBot,
		profileBackdrop,
		closeNestedProfile,
		closeCurrentDrawerScreen,
		profilePane = $bindable(),
		profileFailed = $bindable(),
		paneMobileDetail = $bindable(),
		groupDetail = $bindable()
	}: Props = $props();
</script>

{#if beside}
	{@const sessionId = beside.sessionId}
	{@const botId = beside.botId}
	{@const paneSession = sessionsById.get(sessionId)}
	{@const paneKind = paneSession ? classifySession(paneSession) : null}
	{@const shownBotId = botId ?? (paneKind === 'you-bot' && paneSession ? youBotPeer(paneSession) : null)}
	{@const paneBot = shownBotId ? botsById.get(shownBotId) : undefined}
	<div class="sheet session-settings is-beside" class:is-mobile-detail={paneMobileDetail}>
		<SettingsHead
			group={paneKind === 'group' && !paneBot}
			nested={false}
			onBack={() => {}}
			onClose={() => closePaneSide(sessionId)}
			groupSession={paneKind === 'group' && !paneBot && paneSession ? paneSession : null}
			{t}
			{narrow}
			{runtime}
			{botsById}
			bind:detail={groupDetail}
		/>
		{#if paneBot}
			{#key paneBot.id}
				<ProfilePane
					bind:this={profilePane}
					{runtime}
					bot={paneBot}
					{t}
					selectedKind={paneKind}
					bind:profileFailed
					bind:mobileDetail={paneMobileDetail}
					openDangerConfirm={(kind, run) => (danger.dangerConfirm = { kind, run, source: 'drawer' })}
					clearDanger={(kind) => danger.clearDanger(kind)}
					onDeleteBot={() => danger.openDeleteBotConfirm(paneBot.id)}
					onClearHistory={() => danger.openClearHistoryConfirm(sessionId)}
				/>
			{/key}
		{:else if paneSession}
			<GroupPane
				{runtime}
				selected={paneSession}
				{t}
				bind:detail={groupDetail}
				bind:mobileDetail={paneMobileDetail}
				onOpenProfile={(id) => openProfile(id, sessionId)}
				onDeleteGroup={() => danger.openDeleteGroupConfirm(sessionId)}
				onClearHistory={() => danger.openClearHistoryConfirm(sessionId)}
			/>
		{:else}
			<p class="pane-settings-gone">{t.top.deleted}</p>
		{/if}
	</div>
{:else if runtime.sessionSettingsOpen && selected}
	<!-- svelte-ignore a11y_click_events_have_key_events -->
	<div
		class="profile-backdrop"
		role="dialog"
		aria-modal="true"
		tabindex="-1"
		onmousedowncapture={profileBackdrop.press}
		onclick={(e) => {
			if (danger.drawerHasDanger) return;
			if (profileBackdrop.isOutside(e)) runtime.closeSessionSettings();
		}}
		onkeydown={(e) => {
			if (e.key === 'Escape') {
				if (danger.drawerHasDanger) danger.dismissDangerConfirm();
				else if (nestedProfile && narrow) runtime.closeSessionSettings();
				else if (nestedProfile) closeNestedProfile();
				else if (profilePane?.backFromEditor()) e.stopPropagation();
				else runtime.closeSessionSettings();
			}
		}}
	>
		<div class="sheet is-right session-settings" class:is-mobile-detail={paneMobileDetail}>
			<SettingsHead
				group={selectedKind === 'group'}
				nested={nestedProfile}
				onBack={() => (narrow ? runtime.closeSessionSettings() : closeNestedProfile())}
				onClose={closeCurrentDrawerScreen}
				groupSession={selectedKind === 'group' && !nestedProfile && selected ? selected : null}
				subjectBot={profileBot}
				subjectSession={selected}
				{t}
				{narrow}
				{runtime}
				{botsById}
				bind:detail={groupDetail}
			/>

			{#if profileBot}
				{#key profileBot.id}
					<ProfilePane
						bind:this={profilePane}
						{runtime}
						bot={profileBot}
						{t}
						{selectedKind}
						bind:profileFailed
						bind:mobileDetail={paneMobileDetail}
						openDangerConfirm={(kind, run) => (danger.dangerConfirm = { kind, run, source: 'drawer' })}
						clearDanger={(kind) => danger.clearDanger(kind)}
						onDeleteBot={() => danger.openDeleteBotConfirm()}
						onClearHistory={() => danger.openClearHistoryConfirm()}
					/>
				{/key}
			{:else}
				<GroupPane
					{runtime}
					{selected}
					{t}
					bind:detail={groupDetail}
					bind:mobileDetail={paneMobileDetail}
					onOpenProfile={openProfile}
					onDeleteGroup={() => danger.openDeleteGroupConfirm()}
					onClearHistory={() => danger.openClearHistoryConfirm()}
				/>
			{/if}
		</div>
	</div>
{/if}

<style>
	/* The drawer's sheet, sliding over one pane instead of over the whole window. */
	.sheet.session-settings.is-beside {
		position: relative;
		inset: auto;
		width: 100%;
		height: 100%;
		min-height: 0;
		box-sizing: border-box;
		padding: 0;
		display: flex;
		flex-direction: column;
		overflow: hidden;
		border-right: 0;
		box-shadow: none;
		background: var(--bg);
		z-index: auto;
		animation: none;
	}
	.pane-settings-gone {
		display: flex;
		align-items: center;
		justify-content: center;
		height: 100%;
		color: var(--muted);
		font-size: 13px;
	}

	/* Form Groups & Inputs in Panel */
	.sheet.session-settings :global(.form-group) {
		margin-bottom: 14px;
	}

	.sheet.session-settings :global(.form-group:last-child) {
		margin-bottom: 0;
	}

	.sheet.session-settings :global(.form-group) :global(label),

	.sheet.session-settings :global(.form-group) :global(.field-label) {
		display: block;
		font-size: 12px;
		font-weight: 600;
		color: var(--ink-secondary);
		margin-bottom: 6px;
		letter-spacing: 0.02em;
	}

	/* Group Members List */
	.sheet.session-settings :global(.members) {
		display: flex;
		flex-direction: column;
		gap: 6px;
		padding: 0;
	}

	.sheet.session-settings :global(.member) {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 12px;
		padding: 8px 10px;
		border-radius: var(--radius-md);
		background: var(--line-subtle);
		border: 1px solid transparent;
		transition: 0.15s ease;
		transition-property: var(--transition-props);
	}

	.sheet.session-settings :global(.member:hover) {
		border-color: var(--line);
		background: var(--pane);
		box-shadow: var(--shadow-xs);
	}

	.sheet.session-settings :global(.deny) {
		background: var(--btn-secondary-bg);
		color: var(--danger);
		border: 1px solid var(--danger-line);
	}

	.sheet.session-settings :global(.deny:hover:not(:disabled)) {
		background: var(--danger-bg);
		border-color: var(--danger);
		color: var(--danger);
	}

	/* Persona / Profile Drawer Backdrop & Right Sidebar */
	.profile-backdrop {
		position: fixed;
		inset: 0;
		background: var(--modal-backdrop);
		backdrop-filter: blur(6px);
		-webkit-backdrop-filter: blur(6px);
		display: flex;
		justify-content: flex-end;
		z-index: 80;
		animation: backdropFadeIn 0.2s cubic-bezier(0.16, 1, 0.3, 1);
		overflow: hidden;
	}

	.sheet.is-right {
		position: relative;
		inset: auto;
		width: 340px;
		max-width: 90vw;
		height: 100%;
		border-right: none;
		border-left: 1px solid var(--line);
		box-shadow: var(--shadow-sheet-end);
		z-index: auto;
		animation: slideInRight 0.22s cubic-bezier(0.16, 1, 0.3, 1);
	}

	/*
	 * A phone already has a back chevron on every other settings page. The words ("返回群组设置")
	 * stay for a wider window, where this control is a labelled link, and for the button's name.
	 * The rest of `.sheet-back`'s own styling lives with its markup, in `panels/SettingsHead.svelte`.
	 */
	@media (max-width: 680px) {
		/* The same inset and gap as a section's own head, so what follows Back lines up with its title. */
		.sheet.session-settings:has(:global(.sheet-back)) :global(.sheet-head) {
			padding-left: 4px;
			gap: 4px;
		}
	}

	.sheet.is-right.session-settings {
		width: 460px;
		max-width: 94vw;
		height: 100%;
		max-height: 100vh;
		box-sizing: border-box;
		padding: 0;
		display: flex;
		flex-direction: column;
		overflow: hidden;
		background: var(--bg);
	}

	.sheet.session-settings :global(.sheet-head) {
		padding: 16px 20px;
		margin-bottom: 0;
		border-bottom: 1px solid var(--line);
		background: var(--pane);
		min-height: 56px;
		box-sizing: border-box;
	}

	.sheet.session-settings :global(.sheet-head) :global(h2) {
		font-size: 15px;
		font-weight: 700;
		color: var(--ink);
		letter-spacing: -0.01em;
		margin: 0;
	}

	.sheet.session-settings :global(.profile-pane) {
		flex: 1 1 0;
		min-height: 0;
		display: flex;
		flex-direction: column;
		overflow: hidden;
	}

	@media (max-width: 680px) {
		/* Bot and group settings are a page here, not a drawer peeking past a backdrop. */
		.profile-backdrop {
			background: var(--bg);
			backdrop-filter: none;
			-webkit-backdrop-filter: none;
		}

		.sheet.is-right.session-settings {
			width: 100%;
			max-width: 100%;
			border-left: 0;
			box-shadow: none;
			animation: none;
		}

		.sheet.session-settings :global(.sheet-head) {
			min-height: calc(56px + env(safe-area-inset-top));
			padding: env(safe-area-inset-top) 12px 0 16px;
		}

		/* One header per screen: the section brings its own, with the way back in it. */
		.sheet.session-settings.is-mobile-detail :global(.sheet-head) {
			display: none;
		}
	}
</style>
