<script lang="ts">
	/** Swaps the conversation under a trace, so a test can watch the flow follow it. */
	import type { Bot, SessionSummary } from '@real-bot/protocol';
	import type { Copy } from '../copy.ts';
	import type { MessengerApi } from '../messenger-api.ts';
	import TaskTrace from './TaskTrace.svelte';

	let {
		api,
		sessions,
		bots,
		t
	}: { api: MessengerApi; sessions: SessionSummary[]; bots: Bot[]; t: Copy } = $props();

	let sessionId = $state('group-1');
</script>

<button type="button" data-switch onclick={() => (sessionId = 'direct-9')}>switch</button>
<TaskTrace
	{api}
	taskId="task-1"
	{sessionId}
	activeSessionId={sessionId}
	{sessions}
	{bots}
	youLabel="你"
	deletedLabel="已删除"
	workspacePath="/work"
	{t}
	reloadToken={0}
	onClose={() => {}}
	onJump={() => {}}
/>
