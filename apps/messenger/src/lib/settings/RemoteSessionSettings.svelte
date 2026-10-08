<script lang="ts">
	import type { Copy } from '../copy.ts';
	import type { MessengerRuntime } from '../runtime.svelte.ts';

	type Props = {
		runtime: MessengerRuntime;
		t: Copy;
	};

	let { runtime, t }: Props = $props();
</script>

<p class="muted">{t.remote.uvNeeded}</p>
{#if runtime.uvError}
	<p class="field-error">{t.remote.uvFailed}</p>
{/if}
{#if !runtime.uvReady}
	<button type="button" onclick={() => void runtime.registerUv()}>{t.remote.uvRegister}</button>
{/if}
<div class="settings-maintenance" data-testid="remote-maintenance">
	<h4 class="settings-card-title">{t.remote.maintenance}</h4>
	<p class="muted">{t.remote.maintenanceLead}</p>
	{#if runtime.maintenance}
		<p data-testid="remote-version">{t.remote.version(runtime.maintenance.version)}</p>
		<p data-testid="remote-mode">
			{runtime.maintenance.mode === 'window'
				? t.remote.modeWindow
				: runtime.maintenance.mode === 'standalone'
					? t.remote.modeStandalone
					: t.remote.modeNone}
		</p>
		<p data-testid="remote-restart">
			{runtime.maintenance.restart === 'available'
				? t.remote.restartAvailable
				: t.remote.restartUnavailable}
		</p>
		<p data-testid="remote-drain">
			{runtime.maintenance.drain.phase === 'draining'
				? t.remote.drainWaiting(runtime.maintenance.drain.remaining)
				: runtime.maintenance.drain.phase === 'drained'
					? (runtime.maintenance.drain.forced ? t.remote.drainForced : t.remote.drainDrained)
					: t.remote.drainRunning}
		</p>
	{/if}
	<p class="muted">{t.remote.reconnectHint}</p>
	{#if runtime.maintenanceError}
		<p class="field-error" data-testid="remote-maintenance-error">
			{runtime.maintenanceError === 'draining'
				? t.remote.errorDraining
				: runtime.maintenanceError === 'restart_unavailable'
					? t.remote.errorUnavailable
					: runtime.maintenanceError === 'cancelled'
						? t.remote.errorCancelled
						: runtime.maintenanceError === 'request_unknown'
							? t.remote.errorUnknown
							: t.remote.errorUv}
		</p>
	{/if}
	<div class="settings-maintenance-actions">
		<button type="button" data-testid="remote-refresh" onclick={() => void runtime.refreshMaintenance()}>{t.remote.refreshStatus}</button>
		<button type="button" data-testid="remote-diagnostics" disabled={runtime.maintenanceBusy || !runtime.uvReady} onclick={() => void runtime.downloadDiagnostics()}>{t.remote.downloadDiagnostics}</button>
		<button type="button" data-testid="remote-drain-restart" disabled={runtime.maintenanceBusy || !runtime.uvReady || runtime.maintenance?.restart !== 'available'} onclick={() => void runtime.restartRuntime(false)}>{t.remote.drainRestart}</button>
		<button type="button" data-testid="remote-force-restart" disabled={runtime.maintenanceBusy || !runtime.uvReady || runtime.maintenance?.restart !== 'available'} onclick={() => { runtime.maintenanceForceConfirm = true; }}>{t.remote.forceRestart}</button>
		<button type="button" data-testid="remote-stop" disabled={runtime.maintenanceBusy || !runtime.uvReady} onclick={() => { runtime.maintenanceStopConfirm = true; }}>{t.remote.stopRuntime}</button>
	</div>
	{#if runtime.maintenanceForceConfirm}
		<p class="field-error">{t.remote.forceWarn}</p>
		<button type="button" data-testid="remote-force-confirm" onclick={() => void runtime.restartRuntime(true)}>{t.remote.forceConfirm}</button>
		<button type="button" onclick={() => { runtime.maintenanceForceConfirm = false; }}>{t.common.close}</button>
	{/if}
	{#if runtime.maintenanceStopConfirm}
		<p class="field-error">{t.remote.stopWarn}</p>
		<button type="button" data-testid="remote-stop-confirm" onclick={() => void runtime.stopRuntime()}>{t.remote.stopConfirm}</button>
		<button type="button" onclick={() => { runtime.maintenanceStopConfirm = false; }}>{t.common.close}</button>
	{/if}
	<p class="muted">{t.remote.revokeOther}</p>
	{#if runtime.otherRemoteDevices().length === 0}
		<p class="muted">{t.remote.noOtherDevices}</p>
	{:else}
		<ul class="settings-device-list">
			{#each runtime.otherRemoteDevices() as device (device.id)}
				<li>
					<span>{device.name}</span>
					<button type="button" data-testid={`remote-revoke-${device.id}`} disabled={runtime.maintenanceBusy || !runtime.uvReady} onclick={() => { runtime.maintenanceRevokeId = device.id; }}>{t.remote.revokeOther}</button>
					{#if runtime.maintenanceRevokeId === device.id}
						<button type="button" data-testid={`remote-revoke-confirm-${device.id}`} onclick={() => void runtime.revokeRemoteDevice(device.id)}>{t.remote.revokeConfirm(device.name)}</button>
					{/if}
				</li>
			{/each}
		</ul>
	{/if}
</div>
<div class="settings-row">
	<div class="settings-row-info">
		<span class="settings-row-title" id="push-setting-label">{t.remote.push}</span>
		<span class="settings-row-desc">{t.remote.pushDesc}</span>
	</div>
	<div class="settings-row-action">
		<label class="switch-toggle relative inline-flex items-center cursor-pointer select-none" for="remote-push-toggle" aria-labelledby="push-setting-label">
			<input
				id="remote-push-toggle"
				type="checkbox"
				checked={runtime.pushEnabled}
				disabled={runtime.pushBusy || runtime.pushPermission === 'unsupported'}
				onchange={(ev) =>
					{
const input = ev.currentTarget as HTMLInputElement;
const enabled = input.checked;
input.checked = runtime.pushEnabled;
void runtime.setPushEnabled(enabled);
}}
			/>
			<span class="switch-track" aria-hidden="true">
				<span class="switch-thumb"></span>
			</span>
		</label>
	</div>
</div>
{#if runtime.pushPermission === 'denied'}
	<p class="muted">{t.remote.pushDenied}</p>
{/if}
{#if runtime.pushPermission === 'unsupported'}
	<p class="muted">{t.remote.pushUnsupported}</p>
{/if}
{#if runtime.pushError === 'failed'}
	<p class="field-error" role="alert">{t.remote.pushFailed} {#if runtime.pushErrorCode}<code>{runtime.pushErrorCode}</code>{/if}</p>
{/if}

<style>
	.settings-device-list li {
		display: flex;
		align-items: center;
	}

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

	.settings-row {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 16px;
		padding: 12px 2px;
		border-bottom: 1px solid var(--line-subtle);
		transition: background 0.15s ease;
	}

	.settings-row:last-child {
		border-bottom: none;
		padding-bottom: 2px;
	}

	.settings-row-info {
		display: flex;
		flex-direction: column;
		gap: 2px;
		min-width: 0;
		flex: 1;
	}

	.settings-row-title {
		font-size: 13px;
		font-weight: 500;
		color: var(--ink);
		line-height: 1.3;
	}

	.settings-row-desc {
		font-size: 12px;
		color: var(--muted);
		line-height: 1.35;
	}

	.settings-row-action {
		display: flex;
		align-items: center;
		flex-shrink: 0;
	}

	.switch-toggle :global(input) {
		position: absolute;
		opacity: 0;
		width: 0;
		height: 0;
		margin: 0;
		pointer-events: none;
	}

	.switch-track {
		display: block;
		width: 40px;
		height: 22px;
		border-radius: var(--radius-full);
		background: var(--chip-line);
		transition: background-color 0.2s ease, box-shadow 0.2s ease;
		position: relative;
		box-shadow: inset 0 1px 2px rgba(0, 0, 0, 0.08);
	}

	.switch-thumb {
		position: absolute;
		top: 2px;
		left: 2px;
		width: 18px;
		height: 18px;
		border-radius: 50%;
		background: #ffffff;
		box-shadow: 0 1px 3px rgba(0, 0, 0, 0.25);
		transition: transform 0.2s cubic-bezier(0.16, 1, 0.3, 1);
	}.switch-toggle input:checked + .switch-track{
		background: var(--accent);
	}.switch-toggle input:checked + .switch-track .switch-thumb{
		transform: translateX(18px);
	}.switch-toggle input:focus-visible + .switch-track{
		outline: 2px solid var(--accent);
		outline-offset: 2px;
	}

	@media (max-width: 540px) {
	.settings-row {
	flex-direction: column;
	align-items: flex-start;
	gap: 8px;
	}
	}

	@media (max-width: 540px) {
	.settings-row-action {
	width: 100%;
	justify-content: flex-end;
	}
	}

	@media (max-width: 540px) {
	.settings-device-list li {
		align-items: flex-start;
		flex-direction: column;
	}
	.settings-device-list button {
		min-height: 44px;
	}
	}
</style>
