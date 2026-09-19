<script lang="ts">
	import { tick } from 'svelte';
	import type { McpServer } from '@real-bot/protocol';
	import type { Copy } from '../copy.ts';
	import type { MessengerRuntime } from '../runtime.svelte.ts';
	import {
		formatMcpArgs,
		formatMcpHeaders,
		mapMcpError,
		requestMcpAdd,
		requestMcpSave,
		type McpDraft,
		type McpFieldErrors
	} from './mcp-form.ts';
	import { filterMcpServers, mcpConnectionSummary } from './mcp-list.ts';

	let { runtime, t }: { runtime: MessengerRuntime; t: Copy } = $props();
	const servers = $derived(runtime.snapshot.mcpServers);
	let query = $state('');
	const filteredServers = $derived(filterMcpServers(servers, query));
	let editor = $state<string | null>(null);
	const editing = $derived(servers.find((server) => server.id === editor));
	let draft = $state<McpDraft>(emptyDraft());
	let phase = $state<'edit' | 'confirm'>('edit');
	let errors = $state<McpFieldErrors>({});
	let failed = $state(false);
	let listFailed = $state(false);
	let busy = $state(false);
	let toggling = $state<string[]>([]);
	let addButton: HTMLButtonElement;
	let returnFocus: HTMLElement | null = null;

	$effect(() => {
		if (editor && editor !== 'add' && !editing && !busy) closeEditor();
	});

	function emptyDraft(): McpDraft {
		return { name: '', transport: 'stdio', command: '', args: '', url: '', headers: '', auth: '', enabled: true, usageNote: '' };
	}

	async function openEditor(server?: McpServer): Promise<void> {
		returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
		draft = server
			? {
					name: server.name,
					transport: server.transport,
					command: server.command,
					args: formatMcpArgs(server.args),
					url: server.url ?? '',
					headers: formatMcpHeaders(server.headers),
					auth: '',
					enabled: server.enabled,
					usageNote: server.usage_note ?? ''
				}
			: emptyDraft();
		phase = 'edit';
		errors = {};
		failed = false;
		editor = server?.id ?? 'add';
		await tick();
		document.getElementById('mcp-editor-name')?.focus();
	}

	function closeEditor(): void {
		if (busy) return;
		editor = null;
		draft = emptyDraft();
		phase = 'edit';
		errors = {};
		failed = false;
		if (returnFocus?.isConnected) returnFocus.focus();
		else addButton?.focus();
	}

	function onInput(): void {
		phase = 'edit';
		errors = {};
		failed = false;
	}

	async function submit(): Promise<void> {
		if (busy || !editor) return;
		failed = false;
		errors = {};
		const plan = editor === 'add'
			? requestMcpAdd(phase, draft)
			: editing ? requestMcpSave(phase, editing, draft) : null;
		if (!plan) return;
		if (!plan.ok) {
			errors = plan.errors;
			phase = 'edit';
			await tick();
			document.getElementById(`mcp-editor-${Object.keys(errors)[0]}`)?.focus();
			return;
		}
		if (plan.phase === 'confirm') {
			phase = 'confirm';
			return;
		}
		busy = true;
		const error = 'body' in plan
			? await runtime.createMcpServer(plan.body)
			: Object.keys(plan.patch).length > 0
				? await runtime.patchMcpServer(editor, plan.patch)
				: null;
		busy = false;
		if (!error) {
			query = '';
			closeEditor();
			return;
		}
		const mapped = mapMcpError(error.message);
		if ('top' in mapped) failed = true;
		else {
			errors = mapped;
			phase = 'edit';
		}
	}

	async function removeServer(): Promise<void> {
		if (!editing || busy) return;
		failed = false;
		busy = true;
		const error = await runtime.deleteMcpServer(editing.id);
		busy = false;
		if (error) failed = true;
		else closeEditor();
	}

	async function toggleEnabled(server: McpServer): Promise<void> {
		if (toggling.includes(server.id)) return;
		listFailed = false;
		toggling = [...toggling, server.id];
		const error = await runtime.patchMcpServer(server.id, { enabled: !server.enabled });
		toggling = toggling.filter((id) => id !== server.id);
		if (error) listFailed = true;
	}

	function onEditorKeydown(event: KeyboardEvent): void {
		if (event.key === 'Escape') {
			event.stopPropagation();
			event.preventDefault();
			closeEditor();
		} else if (event.key === 'Tab') {
			const focusable = Array.from((event.currentTarget as HTMLElement).querySelectorAll<HTMLElement>(
				'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled)'
			)).filter((element) => element.getClientRects().length > 0);
			const first = focusable[0];
			const last = focusable.at(-1);
			if (event.shiftKey && document.activeElement === first) {
				event.preventDefault();
				last?.focus();
			} else if (!event.shiftKey && document.activeElement === last) {
				event.preventDefault();
				first?.focus();
			}
		}
	}
</script>

<div class="mcp-settings">
	<div class="mcp-list-toolbar shrink-0 flex flex-col gap-5">
		<div class="mcp-list-heading">
			<h3 class="settings-card-title">{t.settings.sectionMcpServers}</h3>
			<button bind:this={addButton} type="button" class="btn-mcp-add" onclick={() => void openEditor()}>
				{t.settings.sectionMcpAdd}
			</button>
		</div>
		{#if servers.length > 0}
			<div class="mcp-search-row">
				<input
					type="text"
					aria-label={t.settings.mcpSearch}
					placeholder={t.settings.mcpSearch}
					bind:value={query}
				/>
				{#if query}
					<button type="button" class="btn-text-action" onclick={() => (query = '')}>{t.settings.mcpClearSearch}</button>
				{/if}
			</div>
		{/if}
		{#if listFailed}
			<p class="field-error" role="alert">{t.settings.saveFailed}</p>
		{/if}
	</div>
	<div class="mcp-server-list" role="region" aria-label={t.settings.sectionMcpServers}>
		{#if filteredServers.length === 0}
			<div class="mcp-empty" role="status">
				<p class="muted">{servers.length === 0 ? t.settings.mcpEmpty : t.settings.mcpNoResults}</p>
			</div>
		{/if}
		{#each filteredServers as server (server.id)}
			<div class="mcp-server-card" class:is-disabled={!server.enabled}>
				<button
					type="button"
					class="mcp-server-open"
					aria-label={`${t.settings.mcpEdit}: ${server.name}`}
					onclick={() => void openEditor(server)}
				>
					<span class="mcp-server-name text-13p5 font-semibold" title={server.name}>{server.name}</span>
					<span class="mcp-server-meta flex items-center gap-4 min-w-0 max-w-full text-muted text-12">
						<span class="mcp-badge">{server.transport === 'http' ? 'HTTP' : 'stdio'}</span>
						<span class="mcp-server-connection mono" title={mcpConnectionSummary(server)}>{mcpConnectionSummary(server)}</span>
					</span>
				</button>
				<label class="mcp-enable-label">
					<input
						type="checkbox"
						aria-label={`${t.settings.mcpEnabled}: ${server.name}`}
						checked={server.enabled}
						disabled={toggling.includes(server.id)}
						onchange={(event) => {
							event.currentTarget.checked = server.enabled;
							void toggleEnabled(server);
						}}
					/>
					{t.settings.mcpEnabled}
				</label>
			</div>
		{/each}
	</div>
</div>

{#if editor}
	<div
		class="modal-backdrop mcp-editor-backdrop z-[110]"
		role="dialog"
		aria-modal="true"
		aria-labelledby="mcp-editor-title"
		tabindex="-1"
		onclick={(event) => {
			if (event.target === event.currentTarget) closeEditor();
		}}
		onkeydown={onEditorKeydown}
	>
		<form class="modal-dialog mcp-editor-modal" onsubmit={(event) => { event.preventDefault(); void submit(); }} aria-busy={busy}>
			<div class="modal-head">
				<h2 id="mcp-editor-title">{editor === 'add' ? t.settings.sectionMcpAdd : t.settings.mcpEdit}</h2>
				<button type="button" class="modal-close" aria-label={t.common.close} disabled={busy} onclick={closeEditor}>✕</button>
			</div>
			<div class="modal-body">
				<p class="muted mcp-confirm-hint m-0 text-12">{t.settings.mcpMustConfirm}</p>
				{#if failed}
					<p class="field-error" role="alert">{t.settings.saveFailed}</p>
				{/if}
				<fieldset class="mcp-editor-fields" disabled={busy}>
					<div class="modal-section">
						<label for="mcp-editor-name">{t.settings.mcpName}</label>
						<input id="mcp-editor-name" type="text" bind:value={draft.name} oninput={onInput} aria-invalid={!!errors.name} />
						{#if errors.name}<p class="field-error">{t.settings.mcpNameEmpty}</p>{/if}
					</div>
					<div class="modal-section">
						<label for="mcp-editor-transport">{t.settings.mcpTransport}</label>
						<select id="mcp-editor-transport" bind:value={draft.transport} onchange={onInput}>
							<option value="stdio">{t.settings.mcpTransportStdio}</option>
							<option value="http">{t.settings.mcpTransportHttp}</option>
						</select>
					</div>
					{#if draft.transport === 'http'}
						<div class="modal-section">
							<label for="mcp-editor-url">{t.settings.mcpUrl}</label>
							<input id="mcp-editor-url" type="text" class="mono" bind:value={draft.url} oninput={onInput} aria-invalid={!!errors.url} />
							{#if errors.url}<p class="field-error">{errors.url === 'invalid' ? t.settings.mcpUrlInvalid : t.settings.mcpUrlEmpty}</p>{/if}
						</div>
						<div class="modal-section">
							<label for="mcp-editor-headers">{t.settings.mcpHeaders}</label>
							<textarea id="mcp-editor-headers" class="mono" rows="2" bind:value={draft.headers} oninput={onInput}></textarea>
						</div>
						<div class="modal-section">
							<label for="mcp-editor-auth">{t.settings.mcpAuth}</label>
							<input id="mcp-editor-auth" type="password" autocomplete="off" bind:value={draft.auth} placeholder={editing?.auth_set ? '••••' : ''} oninput={onInput} />
							<p class="hint">{t.settings.mcpAuthHint}</p>
						</div>
					{:else}
						<div class="modal-section">
							<label for="mcp-editor-command">{t.settings.mcpCommand}</label>
							<input id="mcp-editor-command" type="text" class="mono" bind:value={draft.command} oninput={onInput} aria-invalid={!!errors.command} />
							{#if errors.command}<p class="field-error">{t.settings.mcpCommandEmpty}</p>{/if}
						</div>
						<div class="modal-section">
							<label for="mcp-editor-args">{t.settings.mcpArgs}</label>
							<input id="mcp-editor-args" type="text" class="mono" bind:value={draft.args} oninput={onInput} />
						</div>
					{/if}
					<div class="modal-section">
						<label for="mcp-editor-usage-note">{t.settings.mcpUsageNote}</label>
						<textarea
							id="mcp-editor-usage-note"
							rows="3"
							bind:value={draft.usageNote}
							oninput={onInput}
							placeholder={t.settings.mcpUsageNotePlaceholder}
						></textarea>
						<p class="hint">{t.settings.mcpUsageNoteHint}</p>
					</div>
					{#if editor === 'add'}
						<label class="mcp-enable-label">
							<input type="checkbox" bind:checked={draft.enabled} onchange={onInput} />
							{t.settings.mcpEnabled}
						</label>
					{/if}
				</fieldset>
			</div>
			<div class="modal-foot actions">
				<button type="submit" disabled={busy}>
					{phase === 'confirm'
						? editor === 'add' ? t.settings.mcpConfirmAdd : t.settings.mcpConfirmEdit
						: editor === 'add' ? t.settings.mcpAdd : t.settings.mcpSave}
				</button>
				<button type="button" disabled={busy} onclick={closeEditor}>{t.settings.mcpCancel}</button>
				{#if editing}
					<button type="button" class="deny" disabled={busy} onclick={() => void removeServer()}>{t.settings.mcpDelete}</button>
				{/if}
			</div>
		</form>
	</div>
{/if}

<style>
	:global(.modal-body) > .mcp-settings {
		flex: 1;
		min-height: 0;
		min-width: 0;
		display: flex;
		flex-direction: column;
		gap: 12px;
	}

	.mcp-list-heading,
	.mcp-search-row {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 12px;
	}

	.mcp-search-row :global(input) {
		min-width: 0;
		flex: 1;
	}

	.mcp-search-row :global(button) {
		flex-shrink: 0;
	}

	.btn-mcp-add {
		flex-shrink: 0;
		border: 1px solid var(--line);
		border-radius: var(--radius-sm);
		background: var(--pane);
		color: var(--accent);
		padding: 7px 10px;
		font-size: 12.5px;
		font-weight: 600;
		cursor: pointer;
	}

	.btn-mcp-add:hover {
		border-color: var(--accent-border);
		background: var(--accent-tint);
	}

	.mcp-server-list {
		min-height: 0;
		overflow-y: auto;
		overscroll-behavior: contain;
		scrollbar-gutter: stable;
		display: flex;
		flex-direction: column;
		gap: 8px;
		padding: 2px;
	}

	.mcp-server-card {
		display: flex;
		align-items: center;
		gap: 12px;
		flex-shrink: 0;
		min-width: 0;
		padding-right: 12px;
		border: 1px solid var(--line);
		border-radius: var(--radius-md);
		background: var(--pane);
	}

	.mcp-server-card:hover,
	.mcp-server-card:focus-within {
		border-color: var(--accent-border);
	}

	.mcp-server-card.is-disabled {
		background: var(--sidebar-bg);
	}

	.mcp-server-open {
		display: flex;
		flex-direction: column;
		gap: 6px;
		flex: 1;
		min-width: 0;
		padding: 12px;
		border: 0;
		border-radius: var(--radius-md);
		background: transparent;
		text-align: left;
		color: var(--ink);
		cursor: pointer;
	}

	.mcp-server-name,
	.mcp-server-connection {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		max-width: 100%;
	}

	.mcp-badge {
		flex-shrink: 0;
		font-size: 10px;
		font-weight: 600;
		padding: 1px 6px;
		border-radius: 4px;
		background: var(--chip);
		border: 1px solid var(--chip-line);
		color: var(--muted);
	}

	.mcp-server-card :global(.mcp-enable-label) {
		flex-shrink: 0;
		white-space: nowrap;
		font-size: 12px;
	}

	.mcp-server-open:focus-visible,
	.btn-mcp-add:focus-visible {
		outline: 2px solid var(--accent);
		outline-offset: 1px;
	}

	.modal-dialog.mcp-editor-modal {
		width: 540px;
		max-width: 95vw;
		max-height: 88vh;
	}

	.mcp-editor-modal > :global(.modal-head),

	.mcp-editor-modal > :global(.modal-foot) {
		flex-shrink: 0;
	}

	.mcp-editor-modal > :global(.modal-body) {
		min-height: 0;
	}

	.mcp-editor-fields {
		border: 0;
		padding: 0;
		margin: 0;
		min-width: 0;
		display: flex;
		flex-direction: column;
		gap: 14px;
	}

	.mcp-editor-modal :global(.modal-foot) {
		flex-wrap: wrap;
	}

	@media (max-width: 540px) {
	.mcp-list-heading {
	align-items: flex-start;
	flex-direction: column;
	gap: 8px;
	}
	}

	@media (max-width: 540px) {
	.mcp-server-card {
	gap: 6px;
	padding-right: 8px;
	}
	}

	@media (max-width: 540px) {
	.mcp-server-open {
	padding: 10px;
	}
	}

	@media (max-width: 540px) {
	.mcp-editor-modal :global(.modal-foot) :global(button) {
	padding-inline: 10px;
	}
	}
</style>
