<script lang="ts">
	import type { Copy } from '../copy.ts';
	import type { MessengerRuntime } from '../runtime.svelte.ts';
	import Switch from '../Switch.svelte';

	/**
	 * The conversation's mute: its replies and routine results stop raising system notifications,
	 * while approvals, questions and failures still do. A row of a group's actions, or of a Bot's
	 * actions in your direct.
	 */
	interface Props {
		runtime: MessengerRuntime;
		sessionId: string;
		t: Copy;
	}

	let { runtime, sessionId, t }: Props = $props();
</script>

<div class="action-list-row" data-session-mute>
	<div class="action-list-info">
		<span class="action-list-title">{t.notifications.sessionMute}</span>
		<span class="action-list-desc">{t.notifications.sessionMuteBody}</span>
	</div>
	<Switch>
		<input
			type="checkbox"
			checked={runtime.isSessionMuted(sessionId)}
			aria-label={t.notifications.sessionMute}
			onchange={(e) => void runtime.setSessionMuted(sessionId, (e.currentTarget as HTMLInputElement).checked)}
		/>
	</Switch>
</div>
