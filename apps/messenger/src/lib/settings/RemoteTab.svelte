<script lang="ts">
	import { localeTag } from '../locale-tag.ts';
	import type { Copy } from '../copy.ts';
	import { copyText } from '../clipboard.ts';
	import { formatFingerprint } from '../remote/fingerprint.ts';
	import type { HostRelayField } from '../remote/pairing-host.ts';
	import type { MessengerRuntime } from '../runtime.svelte.ts';
	import { formatDeviceLastActive } from './device-last-active.ts';
	import RelayGuide from './RelayGuide.svelte';
	import RemoteScreenSettings from './RemoteScreenSettings.svelte';
	import RemoteSessionSettings from './RemoteSessionSettings.svelte';

	type Props = {
		runtime: MessengerRuntime;
		t: Copy;
		locale: 'zh' | 'en';
		relativeTimeNow: number;
		/** The relay form and the copied mark belong to the modal, so they outlive a tab switch. */
		pairingCopied: boolean;
		relayForm: { origin: string; relayId: string; bootstrap: string };
		relayInvalid: HostRelayField | null;
		connectRelay: (event: SubmitEvent) => Promise<void>;
	};

	let {
		runtime,
		t,
		locale,
		relativeTimeNow,
		pairingCopied = $bindable(),
		relayForm = $bindable(),
		relayInvalid,
		connectRelay
	}: Props = $props();

	/** Before this Mac is registered with a relay there is nothing to pair; the card asks for one. */
	const relayConnectable = $derived(
		!runtime.remote && runtime.remoteStatus?.state === 'off' && !runtime.remoteStatus.diagnostic
	);

	function relaySetupMessage(code: string): string {
		if (code === 'relay_bootstrap') return t.remote.hostConnectRefused;
		if (code === 'relay_unreachable') return t.remote.hostConnectUnreachable;
		if (code === 'desktop_channel_unavailable') return t.remote.setupChannelLost;
		return t.remote.hostConnectFailed;
	}

	/**
	 * The badge carries the state; the sentence under it only appears when the state needs
	 * explaining, so "online" does not spend a paragraph saying nothing.
	 */
	const remoteState = $derived(runtime.remoteStatus?.state ?? 'off');
	const remoteLabel = $derived(
		remoteState === 'online'
			? t.remote.statusOnline
			: remoteState === 'connecting'
				? t.remote.statusConnecting
				: remoteState === 'native_unavailable'
					? t.remote.statusUnavailable
					: remoteState === 'activation_gated'
						? t.remote.statusGated
						: remoteState === 'trust_mismatch'
							? t.remote.statusMismatch
							: remoteState === 'disconnected'
								? t.remote.statusDisconnected
								: t.remote.statusOff
	);
	const remoteTone = $derived(
		remoteState === 'online' ? 'ok' : remoteState === 'connecting' ? 'neutral' : remoteState === 'off' ? 'neutral' : 'warn'
	);
	const remoteExplains = $derived(remoteState === 'online' || remoteState === 'off' ? '' : t.remote.experimental);
	/** Why the card offers no connect form when the runtime, not the relay, is what stands in the way. */
	const remoteSetupNote = $derived(
		runtime.remote
			? ''
			: runtime.remoteStatus?.diagnostic === 'sealed_runtime_required'
				? t.remote.setupNeedsDevSwitch
				: ''
	);
</script>

<div class="settings-tab-pane">
	<div class="settings-card settings-card-remote">
		<div class="settings-card-header">
			<div class="settings-card-header-main">
				<div>
					<h3 class="settings-card-title">{t.settings.remoteSection}</h3>
					<p class="settings-card-subtitle">{runtime.remote ? t.settings.remoteSubtitle : t.settings.remoteSubtitleHost}</p>
				</div>
				<span class="settings-badge-{remoteTone}" data-testid="remote-state">{remoteLabel}</span>
			</div>
		</div>
		{#if remoteExplains}
			<p class="muted">{remoteLabel === t.remote.statusGated ? t.remote.experimental : remoteExplains}</p>
		{/if}
		{#if remoteSetupNote}
			<p class="muted" data-testid="remote-setup-note">{remoteSetupNote}</p>
		{/if}

		{#if relayConnectable}
			<form class="relay-connect" data-testid="remote-connect" onsubmit={connectRelay}>
				<p class="pairing-invite-text">{t.remote.hostConnectIntro}</p>
				<RelayGuide {t} {locale} />
				<fieldset class="relay-connect-fields" disabled={runtime.hostSetupBusy}>
					<div class="modal-section">
						<label for="relay-connect-origin">{t.remote.hostConnectOrigin}</label>
						<input
							id="relay-connect-origin"
							type="text"
							class="mono"
							inputmode="url"
							autocomplete="off"
							spellcheck="false"
							placeholder="https://relay.example.com"
							bind:value={relayForm.origin}
							aria-invalid={relayInvalid === 'origin'}
						/>
						{#if relayInvalid === 'origin'}<p class="field-error">{t.remote.hostConnectInvalidOrigin}</p>{/if}
					</div>
					<div class="modal-section">
						<label for="relay-connect-id">{t.remote.hostConnectRelayId}</label>
						<input
							id="relay-connect-id"
							type="text"
							class="mono"
							autocomplete="off"
							spellcheck="false"
							bind:value={relayForm.relayId}
							aria-invalid={relayInvalid === 'relayId'}
						/>
						{#if relayInvalid === 'relayId'}<p class="field-error">{t.remote.hostConnectInvalidRelayId}</p>{/if}
					</div>
					<div class="modal-section">
						<label for="relay-connect-token">{t.remote.hostConnectToken}</label>
						<input
							id="relay-connect-token"
							type="password"
							class="mono"
							autocomplete="off"
							bind:value={relayForm.bootstrap}
							aria-invalid={relayInvalid === 'bootstrap'}
						/>
						{#if relayInvalid === 'bootstrap'}
							<p class="field-error">{t.remote.hostConnectInvalidToken}</p>
						{:else}
							<p class="field-hint muted">{t.remote.hostConnectTokenHint}</p>
						{/if}
					</div>
				</fieldset>
				{#if runtime.hostSetupError}
					<p class="field-error" role="alert" data-testid="remote-connect-error">{relaySetupMessage(runtime.hostSetupError)}</p>
				{/if}
				<button
					type="submit"
					class="btn-pair"
					disabled={runtime.hostSetupBusy || !relayForm.origin.trim() || !relayForm.relayId.trim() || !relayForm.bootstrap.trim()}
				>
					{t.remote.hostConnect}
				</button>
			</form>
		{/if}

		{#if !runtime.remote && runtime.remoteStatus?.state === 'online'}
			<div class="pairing" data-testid="remote-pairing">
				{#if !runtime.hostPairing}
					<div class="pairing-invite">
						<p class="pairing-invite-text">
							{runtime.remoteStatus.devices === 0
								? t.remote.hostPairEmpty
								: t.remote.devices(runtime.remoteStatus.devices)}
						</p>
						<button
							type="button"
							class="btn-pair"
							class:is-quiet={runtime.remoteStatus.devices > 0}
							disabled={runtime.hostPairingBusy}
							onclick={() => void runtime.startHostPairing()}
						>
							{t.remote.hostPair}
						</button>
					</div>
				{:else if runtime.hostPairing.phase === 'offer' || runtime.hostPairing.phase === 'confirm'}
					<ol class="pairing-steps">
						<li>
							<p class="pairing-step-text">{t.remote.hostPairPaste}</p>
							<div class="pairing-code-row">
								<code class="pairing-code mono" data-testid="pairing-code">{runtime.hostPairing.code}</code>
								<button
									type="button"
									class="btn-xs pairing-copy"
									data-testid="pairing-copy"
									onclick={() => {
										copyText(runtime.hostPairing && 'code' in runtime.hostPairing ? runtime.hostPairing.code : '');
										pairingCopied = true;
									}}
								>
									{pairingCopied ? t.chat.copied : t.chat.copyMessage}
								</button>
							</div>
						</li>
						<li>
							<p class="pairing-step-text">{t.remote.hostPairFingerprint}</p>
							<p class="pairing-fingerprint mono">{formatFingerprint(runtime.hostPairing.fingerprint)}</p>
						</li>
						<li>
							{#if runtime.hostPairing.phase === 'offer'}
								<p class="pairing-step-text pairing-waiting">{t.remote.hostPairWaiting}</p>
							{:else}
								<p class="pairing-step-text">{t.remote.hostPairArrived(runtime.hostPairing.name)}</p>
								<p class="pairing-fingerprint mono">{formatFingerprint(runtime.hostPairing.deviceFingerprint)}</p>
								<p class="pairing-step-note">{t.remote.hostPairCompare}</p>
								{#if runtime.hostPairing.note === 'hello_not_configured'}
									<p class="field-error" data-testid="pairing-needs-hello">{t.remote.confirmNeedsHello}</p>
								{/if}
								<div class="pairing-decide">
									<button
										type="button"
										class="btn-pair"
										data-testid="pairing-confirm"
										disabled={runtime.hostPairingBusy}
										onclick={() => void runtime.confirmHostPairing()}
									>
										{t.remote.hostPairApprove}
									</button>
									<button type="button" class="btn-xs" disabled={runtime.hostPairingBusy} onclick={() => runtime.closeHostPairing()}>
										{t.sidebar.cancel}
									</button>
								</div>
							{/if}
						</li>
					</ol>
					{#if runtime.hostPairing.phase === 'offer'}
						<button type="button" class="btn-xs pairing-dismiss" disabled={runtime.hostPairingBusy} onclick={() => runtime.closeHostPairing()}>
							{t.sidebar.cancel}
						</button>
					{/if}
				{:else if runtime.hostPairing.phase === 'paired'}
					<p class="pairing-done" data-testid="pairing-done">{t.remote.hostPairDone}</p>
					<button type="button" class="btn-xs pairing-dismiss" onclick={() => runtime.closeHostPairing()}>{t.common.close}</button>
				{:else}
					<div class="pairing-failed" role="alert">
						<p class="pairing-failed-text">
							{runtime.hostPairing.error === 'expired'
								? t.remote.hostPairExpired
								: runtime.hostPairing.error === 'desktop_channel_unavailable'
									? t.remote.setupChannelLost
									: t.remote.hostPairFailed}
						</p>
						<div class="pairing-failed-actions">
							<button type="button" class="btn-pair" disabled={runtime.hostPairingBusy} onclick={() => void runtime.startHostPairing()}>
								{t.remote.hostPairRetry}
							</button>
							<button type="button" class="btn-xs" onclick={() => runtime.closeHostPairing()}>{t.common.close}</button>
						</div>
					</div>
				{/if}
			</div>
			<div class="connected-devices" data-testid="host-devices">
				<div class="connected-devices-head">
					<h4 class="settings-card-title">{t.remote.connectedDevices}</h4>
					<button type="button" class="btn-xs" disabled={runtime.hostDevicesBusy} onclick={() => void runtime.refreshHostDevices()}>{t.remote.refreshStatus}</button>
				</div>
				{#if runtime.hostDevicesError}
					<p class="field-error">
						{runtime.hostDevicesError === 'hello_not_configured' ? t.remote.confirmNeedsHello : t.remote.deviceActionFailed}
					</p>
				{/if}
				{#if runtime.hostDevices.length === 0}
					<p class="muted">{t.remote.connectedDevicesEmpty}</p>
				{:else}
					<ul class="settings-device-list">
						{#each runtime.hostDevices as device (device.id)}
							<li>
								<div class="device-copy">
									<strong>{device.name}</strong>
									<span lang={localeTag(locale, 'en')}>{device.lastActiveAt ? t.remote.lastActive(formatDeviceLastActive(device.lastActiveAt, relativeTimeNow, locale)) : t.remote.lastActiveUnknown}</span>
								</div>
								<div class="device-actions">
									<button type="button" class="btn-xs" data-testid={`host-remove-${device.id}`} disabled={runtime.hostDevicesBusy} onclick={() => { runtime.hostRemoveDeviceId = device.id; }}>{t.remote.removeDevice}</button>
									{#if runtime.hostRemoveDeviceId === device.id}
										<button type="button" class="btn-danger-xs" data-testid={`host-remove-confirm-${device.id}`} disabled={runtime.hostDevicesBusy} onclick={() => void runtime.removeHostDevice(device.id)}>{t.remote.removeDeviceConfirm(device.name)}</button>
									{/if}
								</div>
							</li>
						{/each}
					</ul>
				{/if}
			</div>
			{#if runtime.client?.kind === 'local'}
				<RemoteScreenSettings api={runtime.client} {t} />
			{/if}
		{:else if runtime.remoteStatus && !runtime.remote && !relayConnectable && !remoteSetupNote}
			<p class="muted">{t.remote.devices(runtime.remoteStatus.devices)}</p>
		{/if}

		<p class="pairing-footnote">{t.remote.noOfflineQueue}</p>
		{#if runtime.remote}
			<RemoteSessionSettings {runtime} {t} />
		{/if}
	</div>
</div>

<style>
	.settings-tab-pane {
		display: flex;
		flex-direction: column;
		gap: 14px;
	}

	.settings-card {
		background: var(--pane);
		border: 1px solid var(--line);
		border-radius: var(--radius-lg);
		padding: 16px 18px;
		display: flex;
		flex-direction: column;
		gap: 12px;
		box-shadow: var(--shadow-xs);
	}

	.settings-card-header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 12px;
	}

	.settings-card-header-main {
		display: flex;
		align-items: center;
		gap: 10px;
		min-width: 0;
	}

	.settings-card-subtitle {
		margin: 2px 0 0;
		font-size: 12px;
		color: var(--muted);
		line-height: 1.35;
	}

	.settings-badge-ok,
	.settings-badge-neutral,
	.settings-badge-warn {
		display: inline-flex;
		align-items: center;
		padding: 2px 8px;
		border-radius: var(--radius-full);
		font-size: 11px;
		font-weight: 600;
		letter-spacing: 0.01em;
		white-space: nowrap;
		flex-shrink: 0;
	}

	.settings-badge-ok {
		background: var(--ok-bg);
		border: 1px solid var(--ok-line);
		color: var(--ok);
	}

	.settings-badge-warn {
		background: var(--warn-bg);
		border: 1px solid var(--warn-line);
		color: var(--warn);
	}

	.settings-badge-neutral {
		background: var(--chip);
		border: 1px solid var(--line);
		color: var(--ink-secondary);
	}

	.connected-devices {
		display: flex;
		flex-direction: column;
		gap: 9px;
	}

	.connected-devices-head,
	.settings-device-list li,
	.device-actions {
		display: flex;
		align-items: center;
	}

	.connected-devices-head,
	.settings-device-list li {
		justify-content: space-between;
		gap: 12px;
	}

	.settings-device-list {
		list-style: none;
		margin: 0;
		padding: 0;
		display: flex;
		flex-direction: column;
		gap: 8px;
	}

	.settings-device-list li {
		padding: 11px 12px;
		border: 1px solid var(--line);
		border-radius: var(--radius-md);
		background: var(--sidebar-bg);
	}

	.device-copy {
		min-width: 0;
		display: flex;
		flex-direction: column;
		gap: 2px;
		font-size: 13px;
	}

	.device-copy span {
		font-size: 12px;
		color: var(--muted);
	}

	.device-actions {
		justify-content: flex-end;
		flex-wrap: wrap;
		gap: 6px;
	}

	.btn-danger-xs {
		color: var(--danger);
		border-color: color-mix(in srgb, var(--danger) 42%, var(--line));
		background: color-mix(in srgb, var(--danger) 8%, transparent);
	}

	/* Pairing is a short sequence with one action at its end, so it reads as steps rather than
	   as another stack of paragraphs inside the card. */
	.pairing {
		display: flex;
		flex-direction: column;
		gap: 10px;
	}

	.pairing-invite {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		justify-content: space-between;
		gap: 12px;
		padding: 12px 14px;
		border: 1px dashed var(--line);
		border-radius: var(--radius-md);
		background: var(--sidebar-bg);
	}

	.pairing-invite-text {
		margin: 0;
		font-size: 13px;
		color: var(--ink-secondary);
	}

	/* The step before pairing: register this Mac with the person's relay, once. */
	.relay-connect {
		display: flex;
		flex-direction: column;
		gap: 12px;
		padding: 12px 14px;
		border: 1px dashed var(--line);
		border-radius: var(--radius-md);
		background: var(--sidebar-bg);
	}

	.relay-connect-fields {
		display: flex;
		flex-direction: column;
		gap: 10px;
		min-width: 0;
		margin: 0;
		padding: 0;
		border: 0;
	}

	.relay-connect .field-error {
		margin: 0;
	}

	.btn-pair {
		align-self: flex-start;
		padding: 7px 14px;
		border-radius: var(--radius-md);
		border: 1px solid var(--accent);
		background: var(--accent);
		color: var(--on-accent);
		font-size: 13px;
		font-weight: 600;
		white-space: nowrap;
	}

	.btn-pair:hover:not(:disabled) {
		filter: brightness(1.08);
	}

	.btn-pair:disabled {
		opacity: 0.55;
		cursor: default;
	}

	/* A second device is routine, so the button steps back to match the rest of the card. */
	.btn-pair.is-quiet {
		background: var(--btn-secondary-bg);
		border-color: var(--line);
		color: var(--accent);
	}

	.pairing-steps {
		counter-reset: pairing-step;
		list-style: none;
		margin: 0;
		padding: 14px 16px;
		display: flex;
		flex-direction: column;
		gap: 14px;
		border: 1px solid var(--line);
		border-radius: var(--radius-md);
		background: var(--sidebar-bg);
	}

	.pairing-steps li {
		counter-increment: pairing-step;
		display: flex;
		flex-direction: column;
		gap: 6px;
		padding-left: 26px;
		position: relative;
	}

	.pairing-steps li::before {
		content: counter(pairing-step);
		position: absolute;
		left: 0;
		top: 1px;
		width: 18px;
		height: 18px;
		border-radius: var(--radius-full);
		border: 1px solid var(--line);
		background: var(--pane);
		color: var(--ink-secondary);
		font-size: 11px;
		font-weight: 600;
		display: flex;
		align-items: center;
		justify-content: center;
	}

	.pairing-step-text {
		margin: 0;
		font-size: 13px;
		color: var(--ink);
		line-height: 1.5;
	}

	.pairing-step-note {
		margin: 0;
		font-size: 12px;
		color: var(--ink-secondary);
	}

	.pairing-waiting {
		color: var(--ink-secondary);
	}

	/* Wrapping follows the card, not the viewport: this panel also renders inside a narrow pane. */
	.pairing-code-row {
		display: flex;
		flex-wrap: wrap;
		align-items: stretch;
		gap: 8px;
	}

	.pairing-code {
		flex: 1 1 200px;
		min-width: 0;
		padding: 8px 10px;
		border: 1px solid var(--line);
		border-radius: var(--radius-sm);
		background: var(--input-bg);
		color: var(--ink-secondary);
		font-size: 11px;
		line-height: 1.5;
		/* The whole code matters, so it wraps instead of hiding its tail behind an ellipsis. */
		overflow-wrap: anywhere;
		max-height: 72px;
		overflow-y: auto;
	}

	.pairing-copy {
		align-self: flex-start;
	}

	.pairing-decide {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 8px;
		margin-top: 2px;
	}

	.pairing-fingerprint {
		margin: 0;
		font-size: 12px;
		line-height: 1.6;
		color: var(--ink);
		overflow-wrap: anywhere;
	}

	.pairing-dismiss {
		align-self: flex-start;
	}

	.pairing-done {
		margin: 0;
		font-size: 13px;
		color: var(--ok);
	}

	.pairing-failed {
		display: flex;
		flex-direction: column;
		gap: 10px;
		padding: 12px 14px;
		border: 1px solid var(--warn-line);
		border-radius: var(--radius-md);
		background: var(--warn-bg);
	}

	.pairing-failed-text {
		margin: 0;
		font-size: 13px;
		color: var(--warn-text);
	}

	.pairing-failed-actions {
		display: flex;
		align-items: center;
		gap: 8px;
	}

	.pairing-footnote {
		margin: 0;
		font-size: 12px;
		color: var(--ink-secondary);
		opacity: 0.85;
	}

	@media (max-width: 720px) {
		.settings-tab-pane {
			gap: 12px;
		}

		.settings-card {
			border-radius: var(--radius-lg);
			padding: 15px;
			box-shadow: none;
		}
	}

	@media (max-width: 540px) {
	.settings-device-list li {
		align-items: flex-start;
		flex-direction: column;
	}
	.device-actions {
		width: 100%;
		justify-content: flex-start;
	}
	.settings-device-list button {
		min-height: 44px;
	}
	}
</style>
