<script lang="ts">
	import type { Copy } from '../copy.ts';
	import type { MessengerRuntime } from '../runtime.svelte.ts';
	import type { IndependentStatus } from './independent-runtime.ts';

	type Props = {
		runtime: MessengerRuntime;
		t: Copy;
		independent: IndependentStatus;
		independentConfirm: 'enable' | 'disable' | null;
		independentReason: (status: IndependentStatus) => string;
		confirmIndependent: () => Promise<void>;
		waitIndependent: () => Promise<void>;
		forceIndependent: () => Promise<void>;
		cancelIndependent: () => Promise<void>;
	};

	let {
		runtime,
		t,
		independent,
		independentConfirm,
		independentReason,
		confirmIndependent,
		waitIndependent,
		forceIndependent,
		cancelIndependent
	}: Props = $props();
</script>

{#if runtime.settingsOpen && independentConfirm}
	<!-- svelte-ignore a11y_click_events_have_key_events -->
	<div
		class="modal-backdrop confirm-backdrop z-[120]"
		role="dialog"
		aria-modal="true"
		aria-labelledby="independent-runtime-confirm-title"
		tabindex="-1"
		onclick={(e) => {
			if (e.target === e.currentTarget && independent.drain.phase !== 'draining') void cancelIndependent();
		}}
	>
		<div class="modal-dialog confirm-dialog">
			<div class="modal-head">
				<h2 id="independent-runtime-confirm-title">
					{independentConfirm === 'enable'
						? t.settings.independentRuntimeConfirmEnable
						: t.settings.independentRuntimeConfirmDisable}
				</h2>
				<button type="button" class="modal-close" title={t.common.close} onclick={() => void cancelIndependent()}>✕</button>
			</div>
			<div class="modal-body">
				<p class="confirm-copy">
					{independentConfirm === 'enable'
						? t.settings.independentRuntimeConfirmEnableBody
						: t.settings.independentRuntimeConfirmDisableBody}
				</p>
				{#if independent.drain.phase === 'draining'}
					<p class="confirm-copy" data-independent-waiting>{t.settings.independentRuntimeWaiting}</p>
				{/if}
				{#if independent.error}
					<p class="confirm-copy" data-independent-error>{independentReason(independent)}</p>
				{/if}
			</div>
			<div class="modal-foot actions">
				{#if independent.drain.phase === 'draining'}
					<button type="button" onclick={() => void waitIndependent()}>{t.settings.independentRuntimeWaiting}</button>
					<button type="button" class="deny" onclick={() => void forceIndependent()}>{t.settings.independentRuntimeForce}</button>
					<button type="button" onclick={() => void cancelIndependent()}>{t.settings.independentRuntimeCancel}</button>
				{:else}
					<button type="button" onclick={() => void cancelIndependent()}>{t.settings.independentRuntimeCancel}</button>
					<button type="button" class="deny" onclick={() => void confirmIndependent()}>{t.settings.independentRuntimeConfirm}</button>
				{/if}
			</div>
		</div>
	</div>
{/if}
