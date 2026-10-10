<script lang="ts">
	import type { Copy } from '../copy.ts';
	import type { MessengerRuntime } from '../runtime.svelte.ts';
	import { spendCopyFor } from '../spend/spend-copy.ts';
	import type { ShellWorkbench } from './shell-workbench.svelte.ts';

	/**
	 * What a pane's new-tab menu lists, under its search field: a new terminal, the workspace, the
	 * calendar and the ledger, then the running terminals no tab shows yet, narrowed by the query.
	 * The menu itself (its field, scrolling and placement) is `WorkbenchLeaf`'s; its rows are
	 * styled there too.
	 */
	type Props = {
		runtime: MessengerRuntime;
		t: Copy;
		workbench: ShellWorkbench;
		leafId: string;
		query: string;
	};

	let { runtime, t, workbench, leafId, query }: Props = $props();

	const snapshot = $derived(runtime.snapshot);
	const needle = $derived(query.trim().toLowerCase());
	const listed = $derived(needle
		? workbench.untabbedTerminals.filter((row) =>
				`${workbench.terminalName(row)} ${row.cwd}`.toLowerCase().includes(needle))
		: workbench.untabbedTerminals);
</script>

<button
	type="button"
	class="wb-menu-row"
	role="menuitem"
	onclick={() => void workbench.openNewTerminal(leafId)}
>
	<span class="wb-menu-mark" aria-hidden="true">
		<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
			<polyline points="4 17 10 11 4 5"></polyline>
			<line x1="12" y1="19" x2="20" y2="19"></line>
		</svg>
	</span>
	<span class="wb-menu-name">{t.terminal.newTab}</span>
</button>
<button
	type="button"
	class="wb-menu-row"
	role="menuitem"
	disabled={!snapshot.settings.workspace_path}
	onclick={() => workbench.openInPane(leafId, { kind: 'workspace', selected: null })}
>
	<span class="wb-menu-mark is-quiet" aria-hidden="true">
		<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
			<path d="M3 7.5 12 3l9 4.5-9 4.5L3 7.5Z"></path>
			<path d="M3 12l9 4.5 9-4.5"></path>
			<path d="M3 16.5 12 21l9-4.5"></path>
		</svg>
	</span>
	<span class="wb-menu-name">{t.sidebar.workspace}</span>
</button>
<button
	type="button"
	class="wb-menu-row"
	role="menuitem"
	onclick={() => workbench.openInPane(leafId, { kind: 'routines' })}
>
	<span class="wb-menu-mark is-quiet" aria-hidden="true">
		<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
			<rect x="3" y="5" width="18" height="16" rx="2"></rect>
			<line x1="3" y1="10" x2="21" y2="10"></line>
			<line x1="8" y1="3" x2="8" y2="7"></line>
			<line x1="16" y1="3" x2="16" y2="7"></line>
		</svg>
	</span>
	<span class="wb-menu-name">{t.routines.title}</span>
</button>
<button
	type="button"
	class="wb-menu-row"
	role="menuitem"
	onclick={() => workbench.openInPane(leafId, { kind: 'spend' })}
>
	<span class="wb-menu-mark is-quiet" aria-hidden="true">
		<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
			<line x1="12" y1="1" x2="12" y2="23"></line>
			<path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"></path>
		</svg>
	</span>
	<span class="wb-menu-name">{spendCopyFor(runtime.snapshot.settings.locale === 'en' ? 'en' : 'zh').title}</span>
</button>
<button
	type="button"
	class="wb-menu-row"
	role="menuitem"
	onclick={() => workbench.openInPane(leafId, { kind: 'usage' })}
>
	<span class="wb-menu-mark is-quiet" aria-hidden="true">
		<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
			<path d="M12 14l4-4"></path>
			<path d="M3.34 19a10 10 0 1 1 17.32 0"></path>
		</svg>
	</span>
	<span class="wb-menu-name">{t.usage.title}</span>
</button>
<div class="wb-menu-section" role="presentation">{t.pane.runningTerminals}</div>
{#each listed as row (row.id)}
	<button
		type="button"
		class="wb-menu-row"
		role="menuitem"
		title={row.cwd}
		onclick={() => workbench.openInPane(leafId, { kind: 'terminal', terminalId: row.id })}
	>
		<span class="wb-menu-mark is-quiet" aria-hidden="true">
			<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
				<polyline points="4 17 10 11 4 5"></polyline>
				<line x1="12" y1="19" x2="20" y2="19"></line>
			</svg>
		</span>
		<span class="wb-menu-copy">
			<span class="wb-menu-name">{workbench.terminalName(row)}</span>
			<span class="wb-menu-meta">{row.cwd}</span>
		</span>
	</button>
{:else}
	<p class="wb-menu-empty">{needle ? t.sidebar.emptySearch : t.pane.noRunningTerminals}</p>
{/each}
