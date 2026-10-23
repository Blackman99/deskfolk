<script lang="ts">
	import type { ClaudeCodeSessionListing, ProjectAgent, SessionSummary } from '@real-bot/protocol';
	import Icon from '../Icon.svelte';
	import Button from '../Button.svelte';
	import type { Copy } from '../copy.ts';
	import type { MessengerRuntime } from '../runtime.svelte.ts';
	import { pickWorkspaceFolder, workspacePickerAvailable } from '../settings/pick-workspace.ts';
	import WorkspacePicker from '../settings/WorkspacePicker.svelte';
	import { importRequest, importSubtitle, newProjectRequest, tildePath } from './import-claude-session.ts';
	import { dirDisplay, isAbsoluteDir, listingSpansAccounts, pickerDirs } from './project-groups.ts';

	/**
	 * The sheet's directories for one agent (ADR 0095). To start a session (`new`): each directory
	 * one press away, then a directory of your own — typed or picked on the Mac, browsed on the
	 * Mac's disk from a phone, where there is no folder dialog and typing a full path is no way to
	 * choose one. To carry a terminal session on (`import`): the directories that have any, one
	 * open at a time, with their sessions.
	 */
	type Props = {
		runtime: MessengerRuntime;
		t: Copy;
		agent: ProjectAgent;
		mode: 'new' | 'import';
		/** The terminal sessions the sheet read once; null while they are on the way. */
		items: ClaudeCodeSessionListing[] | null;
		/** The app's own sessions, for the directories you have only used here. */
		sessions: readonly SessionSummary[];
	};

	let { runtime, t, agent, mode, items, sessions }: Props = $props();

	/** The open directory, or `OTHER` for the typed one. */
	const OTHER = '\u0000other';
	const dirs = $derived(pickerDirs(items ?? [], sessions, agent).filter((entry) => mode === 'new' || entry.listings.length > 0));
	const accounts = $derived(listingSpansAccounts(items ?? []));
	let open = $state<string | null>(null);
	/** With nothing to list, the typed directory is all there is: open it. */
	const shown = $derived(open ?? (mode === 'new' && dirs.length === 0 ? OTHER : null));

	/** How many of a directory's sessions show before you ask for the rest. */
	const FIRST = 8;
	let allShown = $state(false);
	let picked = $state<ClaudeCodeSessionListing | null>(null);
	let typed = $state('');
	let pending = $state(false);
	let startError = $state<'invalid' | 'failed' | null>(null);
	let importError = $state<'missing' | 'failed' | null>(null);
	const locale = $derived(runtime.snapshot.settings.locale === 'en' ? 'en' : 'zh');
	const now = Date.now();
	const canPick = workspacePickerAvailable();

	function toggle(key: string): void {
		open = shown === key ? null : key;
		allShown = false;
		picked = null;
		startError = null;
		importError = null;
	}

	function accountOf(listing: ClaudeCodeSessionListing): string | null {
		if (!accounts) return null;
		return listing.config_dir ? tildePath(listing.config_dir) : t.project.defaultAccount;
	}

	async function start(dir: string): Promise<void> {
		if (pending) return;
		if (!isAbsoluteDir(dir)) {
			startError = 'invalid';
			return;
		}
		pending = true;
		startError = null;
		const failure = await runtime.createProjectSession(newProjectRequest(dir, agent));
		pending = false;
		if (failure) startError = failure.status === 422 || failure.status === 404 ? 'invalid' : 'failed';
	}

	async function carryOn(): Promise<void> {
		if (!picked || pending) return;
		pending = true;
		importError = null;
		const failure = await runtime.createProjectSession(importRequest(picked));
		pending = false;
		// A session file that went away since the list was read.
		if (failure) importError = failure.status === 404 ? 'missing' : 'failed';
	}

	async function pickFolder(): Promise<void> {
		try {
			const folder = await pickWorkspaceFolder(typed, t.project.pickTitle);
			if (folder) {
				typed = folder;
				startError = null;
			}
		} catch {
			startError = 'failed';
		}
	}
</script>

{#snippet startFailure()}
	{#if startError}
		<p class="field-error" data-project-error>{startError === 'invalid' ? t.project.dirInvalid : t.sidebar.saveFailed}</p>
	{/if}
{/snippet}

<div class="picker" data-project-dirs>
	{#if mode === 'new' && shown !== OTHER}
		{@render startFailure()}
	{/if}
	{#if mode === 'import' && items && dirs.length === 0}
		<p class="muted field-hint">{t.sidebar.importClaudeEmpty}</p>
	{/if}
	{#each dirs as entry (entry.dir)}
		{@const isOpen = shown === entry.dir}
		{#if mode === 'new'}
			<!-- One press starts the session there: a directory you have used is a place, not a question. -->
			<div class="picker-dir" data-picker-dir={entry.dir}>
				<button type="button" class="picker-head" title={entry.dir} disabled={pending} data-picker-start onclick={() => void start(entry.dir)}>
					<Icon name="folder" size={16} />
					<span class="picker-names">
						<span class="picker-name">{entry.label}</span>
						<span class="picker-path muted">{tildePath(entry.dir)}</span>
					</span>
					<span class="picker-go"><Icon name="plus" size={16} /></span>
				</button>
			</div>
		{:else}
		<div class="picker-dir" class:is-open={isOpen} data-picker-dir={entry.dir}>
			<button type="button" class="picker-head" aria-expanded={isOpen} title={entry.dir} onclick={() => toggle(entry.dir)}>
				<Icon name={isOpen ? 'chevron-down' : 'chevron-right'} size={12} />
				<Icon name="folder" size={16} />
				<span class="picker-names">
					<span class="picker-name">{entry.label}</span>
					<span class="picker-path muted">{tildePath(entry.dir)}</span>
				</span>
				{#if entry.listings.length > 0}
					<span class="picker-count muted" title={t.project.dirSessions(entry.listings.length)}>{entry.listings.length}</span>
				{/if}
			</button>
			{#if isOpen}
				<div class="picker-body">
					{#if entry.listings.length > 0}
						<span class="muted field-hint">{t.project.carryHead}</span>
						<div class="import-list" role="listbox" aria-label={t.sidebar.importClaudeList}>
							{#each allShown ? entry.listings : entry.listings.slice(0, FIRST) as session (session.session_id)}
								<button
									type="button"
									class="import-row"
									class:active={picked?.session_id === session.session_id}
									role="option"
									aria-selected={picked?.session_id === session.session_id}
									data-claude-session={session.session_id}
									onclick={() => {
										picked = session;
										importError = null;
									}}
								>
									<span class="import-title">{session.title || t.sidebar.importClaudeNoTitle}</span>
									<span class="import-meta muted">{importSubtitle(session, now, locale, accountOf(session))}</span>
								</button>
							{/each}
						</div>
						{#if !allShown && entry.listings.length > FIRST}
							<div>
								<Button variant="ghost" size="sm" onclick={() => (allShown = true)}>{t.project.showMore(entry.listings.length - FIRST)}</Button>
							</div>
						{/if}
						{#if picked}
							<!-- Kept in view at the bottom of the body, however far down the list you picked. -->
							<div class="import-form" data-import-form>
								<p class="muted field-hint">{t.sidebar.importClaudeHint}</p>
								{#if importError}
									<p class="field-error">{importError === 'missing' ? t.sidebar.importClaudeMissing : t.sidebar.saveFailed}</p>
								{/if}
								<div>
									<Button variant="primary" disabled={pending} onclick={() => void carryOn()}>{t.sidebar.importClaudeSubmit}</Button>
								</div>
							</div>
						{/if}
					{/if}
				</div>
			{/if}
		</div>
		{/if}
	{/each}
	{#if mode === 'new'}
	<div class="picker-dir" class:is-open={shown === OTHER} data-picker-other>
		<button type="button" class="picker-head" aria-expanded={shown === OTHER} onclick={() => toggle(OTHER)}>
			<Icon name={shown === OTHER ? 'chevron-down' : 'chevron-right'} size={12} />
			<Icon name="plus" size={16} />
			<span class="picker-names"><span class="picker-name">{t.project.otherDir}</span></span>
		</button>
		{#if shown === OTHER}
			<div class="picker-body" data-project-new>
				<label for="project-dir">{t.project.dirLabel}</label>
				{#if runtime.remote}
					<WorkspacePicker
						id="project-dir"
						path={typed}
						chooseLabel={t.project.browse}
						changeLabel={t.project.browse}
						emptyLabel={t.project.browseEmpty}
						unavailableLabel={t.project.browseFailed}
						dialogTitle={t.project.pickTitle}
						remote
						api={runtime.client}
						browseHint={t.project.browseHint}
						permissionHint={t.settings.workspaceAuthorizeMac}
						truncatedHint={t.stream.workspaceTruncated}
						upLabel={t.settings.workspaceUp}
						useLabel={t.settings.workspaceUseFolder}
						cancelLabel={t.sidebar.cancel}
						shown={dirDisplay}
						onChange={(next) => {
							typed = next;
							startError = null;
						}}
					/>
				{:else}
				<div class="dir-row">
					<input
						id="project-dir"
						type="text"
						placeholder={t.project.dirPlaceholder}
						autocomplete="off"
						spellcheck="false"
						bind:value={typed}
						oninput={() => (startError = null)}
						onkeydown={(e) => {
							if (e.key === 'Enter' && !e.isComposing) void start(typed);
						}}
					/>
					{#if canPick}
						<Button icon="folder" onclick={() => void pickFolder()}>{t.project.pick}</Button>
					{/if}
				</div>
				{/if}
				<p class="muted field-hint">{t.project.dirHints[agent]}</p>
				{@render startFailure()}
				<div>
					<Button variant="primary" disabled={pending || !typed.trim()} onclick={() => void start(typed)}>{t.project.start}</Button>
				</div>
			</div>
		{/if}
	</div>
	{/if}
</div>

<style>
	.picker {
		display: flex;
		flex-direction: column;
		gap: 2px;
	}

	.picker-dir.is-open {
		border-radius: var(--radius-md);
		background: var(--line-subtle);
	}

	.picker-head {
		display: flex;
		align-items: center;
		gap: 8px;
		width: 100%;
		min-height: 44px;
		padding: 6px 10px;
		border-radius: var(--radius-md);
		color: var(--ink);
		text-align: left;
	}

	.picker-head:hover {
		background: var(--row-hover);
	}

	.picker-names {
		flex: 1;
		min-width: 0;
		display: flex;
		align-items: baseline;
		gap: 8px;
	}

	.picker-name {
		flex: none;
		max-width: 60%;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		font-size: 13px;
		font-weight: 600;
	}

	.picker-path {
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		font-size: 12px;
	}

	.picker-go {
		flex: none;
		display: inline-flex;
		color: var(--muted);
	}

	.picker-head:hover .picker-go {
		color: var(--accent);
	}

	.picker-count {
		flex: none;
		font-size: 12px;
		font-variant-numeric: tabular-nums;
	}

	/* Under the head's chevron, so what belongs to the directory reads as inside it. */
	.picker-body {
		display: flex;
		flex-direction: column;
		gap: 8px;
		padding: 2px 10px 12px 30px;
	}

	.dir-row {
		display: flex;
		gap: 8px;
		align-items: center;
	}

	.dir-row :global(input) {
		flex: 1;
		min-width: 0;
	}

	.import-list {
		display: flex;
		flex-direction: column;
		gap: 2px;
		margin: 0 -10px;
	}

	.import-row {
		display: flex;
		flex-direction: column;
		align-items: flex-start;
		gap: 2px;
		min-height: 44px;
		padding: 6px 10px;
		border-radius: 8px;
		text-align: left;
		min-width: 0;
	}

	.import-row:hover {
		background: var(--row-hover);
	}

	.import-row.active {
		background: var(--accent-tint);
	}

	/* Down over the body's own bottom padding (18px), so no row shows beneath it. */
	.import-form {
		position: sticky;
		bottom: -18px;
		display: flex;
		flex-direction: column;
		gap: 8px;
		margin: 0 -10px -12px -30px;
		padding: 12px 10px 18px 30px;
		border-top: 1px solid var(--line);
		background: var(--pane);
	}

	.import-title,
	.import-meta {
		max-width: 100%;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.import-meta {
		font-size: 12px;
	}

	@media (max-width: 680px) {
		.picker-body {
			padding-left: 14px;
		}

		.import-form {
			margin-left: -14px;
			padding-left: 14px;
		}

		.dir-row {
			flex-direction: column;
			align-items: stretch;
		}
	}
</style>
