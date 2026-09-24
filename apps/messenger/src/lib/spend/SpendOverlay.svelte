<script lang="ts">
	import type { MessengerRuntime } from '../runtime.svelte.ts';
	import { pageSlide } from '../mobile-page-slide.ts';
	import SpendView from './SpendView.svelte';

	let { runtime, backLabel }: { runtime: MessengerRuntime; backLabel: string } = $props();
</script>

<div class="spend-page" transition:pageSlide>
	<SpendView
		api={runtime.client}
		revision={runtime.spendRevision}
		locale={runtime.snapshot.settings.locale === 'en' ? 'en' : 'zh'}
		{backLabel}
		onClose={() => runtime.closeSpend()}
		onOpenSession={(sessionId) => void runtime.openChat(sessionId)}
		onOpenTrigger={(sessionId, messageId) => void runtime.openChat(sessionId, { messageId })}
	/>
</div>

<style>
	.spend-page { position: absolute; inset: 0; display: flex; flex-direction: column; min-width: 0; min-height: 0; background: var(--pane); z-index: 2; }
</style>
