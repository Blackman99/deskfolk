<script lang="ts">
	import Icon from '../Icon.svelte';
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
		<Icon name="terminal" />
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
		<Icon name="layers" />
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
		<Icon name="calendar" />
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
		<Icon name="dollar" />
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
		<Icon name="gauge" />
	</span>
	<span class="wb-menu-name">{t.usage.title}</span>
</button>
<button
	type="button"
	class="wb-menu-row"
	role="menuitem"
	data-new-pane="roles"
	onclick={() => workbench.openInPane(leafId, { kind: 'roles' })}
>
	<span class="wb-menu-mark is-quiet" aria-hidden="true">
		<Icon name="nodes" />
	</span>
	<span class="wb-menu-name">{t.routing.tab}</span>
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
			<Icon name="terminal" />
		</span>
		<span class="wb-menu-copy">
			<span class="wb-menu-name">{workbench.terminalName(row)}</span>
			<span class="wb-menu-meta">{row.cwd}</span>
		</span>
	</button>
{:else}
	<p class="wb-menu-empty">{needle ? t.sidebar.emptySearch : t.pane.noRunningTerminals}</p>
{/each}
