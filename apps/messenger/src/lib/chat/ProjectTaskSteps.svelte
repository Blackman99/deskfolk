<script lang="ts">
	import type { AgentRunTask } from '@real-bot/protocol';
	import type { MessengerRuntime } from '../runtime.svelte.ts';
	import type { StepRow } from './turn-activity.ts';
	import TurnStepList from './TurnStepList.svelte';

	/**
	 * What a project session's working bubble opens onto (ADR 0095, 25): the list a Bot's does, with
	 * what a background command prints. A Bot's bytes come over the stream; these the Mac reads from
	 * Claude Code's own files, so they are asked for while the list is open, and only then.
	 */
	type Props = {
		runtime: MessengerRuntime;
		id: string;
		title: string;
		rows: StepRow[];
		/** The commands going on now, whose output is read. */
		tasks: readonly AgentRunTask[];
		onClose: () => void;
	};

	let { runtime, id, title, rows, tasks, onClose }: Props = $props();

	const POLL_MS = 1500;

	let outputs = $state<Record<string, string>>({});
	// Which ones, not their progress: each event of the run brings new task objects.
	const asked = $derived(tasks.map((task) => `${task.run_id}/${task.id}`).join(' '));

	$effect(() => {
		const api = runtime.client;
		const each = asked ? asked.split(' ').map((key) => key.split('/') as [string, string]) : [];
		if (!api || each.length === 0) return;
		let gone = false;
		let timer: ReturnType<typeof setTimeout> | null = null;
		const read = async () => {
			await Promise.all(each.map(async ([run, task]) => {
				try {
					const detail = await api.agentTaskDetail(run, task);
					if (!gone && detail.output !== null) outputs = { ...outputs, [task]: detail.output };
				} catch {
					// The next read tries again; the row still says what runs.
				}
			}));
			if (!gone) timer = setTimeout(() => void read(), POLL_MS);
		};
		void read();
		return () => {
			gone = true;
			if (timer) clearTimeout(timer);
		};
	});
</script>

<TurnStepList {id} {title} {rows} outputOf={(task) => outputs[task] || null} {onClose} />
