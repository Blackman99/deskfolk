<script lang="ts">
	import { onMount, untrack } from 'svelte';
	import type { Copy } from '../copy.ts';
	import type { MessengerRuntime } from '../runtime.svelte.ts';
	import { classifyPushHealth, closeCopyKey } from '../notifications/tab-owner.ts';
	import { pushPermission } from '../remote/push.ts';
	import type { NotificationPolicyCategories } from '../notifications/types.ts';

	type Props = {
		runtime: MessengerRuntime;
		t: Copy;
	};

	let { runtime, t }: Props = $props();

	let policyLoading = $state(false);
	let deviceLoading = $state(false);
	let testBusy = $state(false);
	let testFeedback = $state<string | null>(null);
	let quietHoursError = $state<string | null>(null);
	let disableFeedback = $state<string | null>(null);

	onMount(() => {
		if (runtime.connection === 'connected' && !runtime.isDesktopShell) {
			if (typeof runtime.prefetchPushState === 'function') {
				void runtime.prefetchPushState();
			}
		}
	});

	$effect(() => {
		if (runtime.connection === 'connected') {
			untrack(() => {
				void loadPolicyAndDevice();
			});
		}
	});

	async function loadPolicyAndDevice(): Promise<void> {
		if (!runtime.client) return;
		try {
			policyLoading = true;
			if ('getNotificationPolicy' in runtime.client) {
				await runtime.loadNotificationPolicy();
			}
			if ('getNotificationDevice' in runtime.client) {
				await runtime.loadNotificationDevice();
			}
		} catch {
			// Handled gracefully in UI
		} finally {
			policyLoading = false;
		}
	}

	const policy = $derived(runtime.notificationPolicy);
	const device = $derived(runtime.notificationDevice);

	async function toggleCategory(category: keyof NotificationPolicyCategories): Promise<void> {
		if (!policy) return;
		const next = !policy.categories[category];
		await runtime.patchNotificationPolicy({
			categories: { [category]: next }
		});
	}

	async function toggleQuietHours(): Promise<void> {
		if (!policy) return;
		const nextEnabled = !policy.quiet_hours.enabled;
		await runtime.patchNotificationPolicy({
			quiet_hours: { enabled: nextEnabled }
		});
	}

	async function updateQuietHoursTimes(start: string, end: string): Promise<void> {
		if (!policy) return;
		if (start === end) {
			quietHoursError = t.notifications.quietHoursEqualTimes;
			return;
		}
		quietHoursError = null;
		await runtime.patchNotificationPolicy({
			quiet_hours: { start, end }
		});
	}

	const permission = $derived(runtime.pushPermission || pushPermission());
	const pushHealth = $derived(
		classifyPushHealth({
			permission,
			standalone: typeof window !== 'undefined' && (window.navigator as unknown as { standalone?: boolean }).standalone === true,
			ios: typeof navigator !== 'undefined' && /iPad|iPhone|iPod/.test(navigator.userAgent),
			transport: runtime.pushTransport,
			enabled: device?.enabled ?? false,
			subscribed: runtime.pushSubscribed || (device?.enabled ?? false),
			recovery: runtime.pushRecovery ?? 'none',
			remoteGate: runtime.remoteGated
		})
	);

	async function handleDeviceToggle(): Promise<void> {
		disableFeedback = null;
		if (runtime.isDesktopShell) {
			if (device?.enabled) {
				await runtime.patchNotificationDevice({ enabled: false });
			} else {
				await runtime.requestDesktopNotificationPermission();
			}
			return;
		}

		if (device?.enabled) {
			const outcome = await runtime.disableDeviceNotifications();
			if (typeof outcome === 'object') {
				const key = closeCopyKey(outcome);
				if (key === 'local_only') disableFeedback = t.notifications.localOnlyClose;
				else if (key === 'host_only') disableFeedback = t.notifications.hostOnlyClose;
				else if (key === 'unconfirmed') disableFeedback = t.notifications.unconfirmedClose;
				else disableFeedback = null;
			}
		} else {
			await runtime.enableDeviceNotifications();
		}
	}

	const usesNativeTestGate = $derived(runtime.isDesktopShell || !runtime.remote);
	const canSendDesktopTest = $derived(
		Boolean(
			usesNativeTestGate &&
				runtime.nativeCapabilities.native_delivery_v1 &&
				runtime.pushPermission === 'granted' &&
				device?.enabled
		)
	);
	const canSendRemoteTest = $derived(
		Boolean(
			!usesNativeTestGate &&
				device?.enabled &&
				!runtime.remoteGated &&
				pushHealth !== 'gated' &&
				pushHealth !== 'paused_upgrade' &&
				pushHealth !== 'unsupported' &&
				pushHealth !== 'denied' &&
				pushHealth !== 'install_required'
		)
	);
	const canSendTest = $derived(canSendDesktopTest || canSendRemoteTest);

	async function handleSendTest(): Promise<void> {
		if (testBusy || !canSendTest) return;
		testBusy = true;
		testFeedback = null;
		try {
			const result = await runtime.sendTestNotification();
			if (result.status === 'accepted') testFeedback = t.notifications.testSent;
			else if (result.status === 'queued' || result.status === 'waiting_send_slot' || result.status === 'submitted') {
				testFeedback = t.notifications.testQueued;
			} else {
				testFeedback = t.notifications.testQueued;
			}
		} catch (err) {
			testFeedback = err instanceof Error ? err.message : t.disconnected.host;
		} finally {
			testBusy = false;
		}
	}
</script>

<div class="notification-settings flex flex-col gap-8">
	<!-- Categories Section -->
	<section class="settings-card">
		<header class="settings-card-head">
			<h3 class="text-14 font-semibold text-ink">{t.notifications.sectionCategories}</h3>
			<p class="text-12 text-muted mt-1">{t.notifications.categoriesSubtitle}</p>
		</header>
		<div class="category-grid grid grid-cols-2 gap-3 mt-4">
			<label class="category-toggle-item flex items-center justify-between p-3 rounded-md bg-pane-alt">
				<span class="text-13 text-ink">{t.notifications.catApproval}</span>
				<input
					type="checkbox"
					checked={policy?.categories.approval ?? true}
					disabled={policyLoading}
					onchange={() => void toggleCategory('approval')}
				/>
			</label>
			<label class="category-toggle-item flex items-center justify-between p-3 rounded-md bg-pane-alt">
				<span class="text-13 text-ink">{t.notifications.catAsk}</span>
				<input
					type="checkbox"
					checked={policy?.categories.ask ?? true}
					disabled={policyLoading}
					onchange={() => void toggleCategory('ask')}
				/>
			</label>
			<label class="category-toggle-item flex items-center justify-between p-3 rounded-md bg-pane-alt">
				<span class="text-13 text-ink">{t.notifications.catFailure}</span>
				<input
					type="checkbox"
					checked={policy?.categories.failure ?? true}
					disabled={policyLoading}
					onchange={() => void toggleCategory('failure')}
				/>
			</label>
			<label class="category-toggle-item flex items-center justify-between p-3 rounded-md bg-pane-alt">
				<span class="text-13 text-ink">{t.notifications.catInterrupted}</span>
				<input
					type="checkbox"
					checked={policy?.categories.interrupted ?? true}
					disabled={policyLoading}
					onchange={() => void toggleCategory('interrupted')}
				/>
			</label>
			<label class="category-toggle-item flex items-center justify-between p-3 rounded-md bg-pane-alt">
				<span class="text-13 text-ink">{t.notifications.catReply}</span>
				<input
					type="checkbox"
					checked={policy?.categories.reply ?? true}
					disabled={policyLoading}
					onchange={() => void toggleCategory('reply')}
				/>
			</label>
			<label class="category-toggle-item flex items-center justify-between p-3 rounded-md bg-pane-alt">
				<span class="text-13 text-ink">{t.notifications.catRoutineResult}</span>
				<input
					type="checkbox"
					checked={policy?.categories.routine_result ?? true}
					disabled={policyLoading}
					onchange={() => void toggleCategory('routine_result')}
				/>
			</label>
		</div>
	</section>

	<!-- Quiet Hours Section -->
	<section class="settings-card">
		<header class="settings-card-head">
			<h3 class="text-14 font-semibold text-ink">{t.notifications.quietHours}</h3>
			<p class="text-12 text-muted mt-1">{t.notifications.quietHoursSubtitle}</p>
		</header>
		<div class="quiet-hours-body mt-4 flex flex-col gap-4">
			<label class="flex items-center justify-between p-3 rounded-md bg-pane-alt">
				<span class="text-13 text-ink font-medium">{t.notifications.quietHoursEnabled}</span>
				<input
					type="checkbox"
					checked={policy?.quiet_hours.enabled ?? false}
					disabled={policyLoading}
					onchange={() => void toggleQuietHours()}
				/>
			</label>
			{#if policy?.quiet_hours.enabled}
				<div class="time-inputs flex items-center gap-4 p-3 rounded-md bg-pane-alt">
					<div class="flex flex-col gap-1 flex-1">
						<label for="quiet-hours-start" class="text-12 text-muted">{t.notifications.quietHoursStart}</label>
						<input
							id="quiet-hours-start"
							type="time"
							class="time-picker px-3 py-1.5 rounded bg-pane text-ink text-13"
							value={policy.quiet_hours.start}
							onchange={(e) => void updateQuietHoursTimes((e.currentTarget as HTMLInputElement).value, policy.quiet_hours.end)}
						/>
					</div>
					<span class="text-muted text-14 mt-4">至</span>
					<div class="flex flex-col gap-1 flex-1">
						<label for="quiet-hours-end" class="text-12 text-muted">{t.notifications.quietHoursEnd}</label>
						<input
							id="quiet-hours-end"
							type="time"
							class="time-picker px-3 py-1.5 rounded bg-pane text-ink text-13"
							value={policy.quiet_hours.end}
							onchange={(e) => void updateQuietHoursTimes(policy.quiet_hours.start, (e.currentTarget as HTMLInputElement).value)}
						/>
					</div>
					{#if policy.quiet_hours.time_zone}
						<div class="flex flex-col gap-1 shrink-0">
							<span class="text-12 text-muted">{t.notifications.quietHoursTimeZone}</span>
							<span class="text-12 text-ink py-1.5 font-mono">{policy.quiet_hours.time_zone}</span>
						</div>
					{/if}
				</div>
				{#if quietHoursError}
					<p class="text-12 text-danger mt-1">{quietHoursError}</p>
				{/if}
			{/if}
		</div>
	</section>

	<!-- Device Notifications Section -->
	<section class="settings-card">
		<header class="settings-card-head">
			<h3 class="text-14 font-semibold text-ink">{t.notifications.deviceNotifications}</h3>
			<p class="text-12 text-muted mt-1">{t.notifications.deviceSubtitle}</p>
		</header>
		<div class="device-body mt-4 flex flex-col gap-4">
			{#if runtime.isDesktopShell}
				{#if runtime.pushPermission === 'denied'}
					<div class="health-notice p-3 rounded-md bg-pane-alt text-13 text-danger">
						{t.notifications.permissionDenied}
					</div>
				{/if}
				<label class="flex items-center justify-between p-3 rounded-md bg-pane-alt">
					<div class="flex flex-col gap-0.5">
						<span class="text-13 text-ink font-medium">{t.notifications.deviceEnable}</span>
						<span class="text-11 text-muted">
							{device?.enabled ? t.notifications.deviceEnabled : t.notifications.deviceDisabled}
						</span>
					</div>
					<input
						type="checkbox"
						checked={device?.enabled ?? false}
						disabled={deviceLoading}
						onchange={() => void handleDeviceToggle()}
					/>
				</label>
			{:else}
				{#if pushHealth === 'unsupported'}
					<div class="health-notice p-3 rounded-md bg-pane-alt text-13 text-muted">
						{t.notifications.pushUnsupported}
					</div>
				{:else if pushHealth === 'install_required'}
					<div class="health-notice p-3 rounded-md bg-pane-alt text-13 text-muted">
						{t.notifications.iosInstallRequired}
					</div>
				{:else if pushHealth === 'denied'}
					<div class="health-notice p-3 rounded-md bg-pane-alt text-13 text-danger">
						{t.notifications.permissionDenied}
					</div>
				{:else if pushHealth === 'gated'}
					<div class="health-notice p-3 rounded-md bg-pane-alt text-13 text-muted">
						{t.notifications.remoteGated}
					</div>
				{:else if pushHealth === 'paused_upgrade'}
					<div class="health-notice p-3 rounded-md bg-pane-alt text-13 text-muted">
						{t.notifications.pushUpgrading}
					</div>
				{:else if pushHealth === 'needs_repair'}
					<div class="health-notice p-3 rounded-md bg-pane-alt flex items-center justify-between">
						<span class="text-13 text-warning">{t.notifications.needsRepair}</span>
						<button
							type="button"
							class="btn-primary text-12 px-3 py-1.5 rounded"
							onclick={() => void runtime.enableDeviceNotifications()}
						>
							{t.notifications.repairButton}
						</button>
					</div>
				{:else}
					<label class="flex items-center justify-between p-3 rounded-md bg-pane-alt">
						<div class="flex flex-col gap-0.5">
							<span class="text-13 text-ink font-medium">{t.notifications.deviceEnable}</span>
							<span class="text-11 text-muted">
								{device?.enabled ? t.notifications.deviceEnabled : t.notifications.deviceDisabled}
							</span>
						</div>
						<input
							type="checkbox"
							checked={device?.enabled ?? false}
							disabled={deviceLoading}
							onchange={() => void handleDeviceToggle()}
						/>
					</label>
				{/if}
				{#if disableFeedback}
					<div class="p-2 text-12 text-warning bg-pane-alt rounded feedback-msg">
						{disableFeedback}
					</div>
				{/if}
			{/if}

			{#if device?.enabled}
				<div class="device-options flex flex-col gap-3 p-3 rounded-md bg-pane-alt">
					<div class="option-row flex items-center justify-between">
						<span class="text-13 text-ink">{t.notifications.deviceSound}</span>
						{#if runtime.hosted}
							<span class="text-12 text-muted">由系统管理</span>
						{:else}
							<select
								class="text-12 bg-pane rounded px-2 py-1 text-ink"
								value={device.sound}
								onchange={(e) => void runtime.patchNotificationDevice({ sound: (e.currentTarget as HTMLSelectElement).value as any })}
							>
								<option value="default">默认</option>
								<option value="system">系统</option>
								<option value="off">静音</option>
							</select>
						{/if}
					</div>
					<div class="option-row flex items-center justify-between">
						<span class="text-13 text-ink">{t.notifications.devicePreview}</span>
						{#if runtime.hosted}
							<span class="text-12 text-muted">{t.notifications.previewGeneric}</span>
						{:else}
							<select
								class="text-12 bg-pane rounded px-2 py-1 text-ink"
								value={device.preview}
								onchange={(e) => void runtime.patchNotificationDevice({ preview: (e.currentTarget as HTMLSelectElement).value as any })}
							>
								<option value="generic">{t.notifications.previewGeneric}</option>
								<option value="reply_excerpt">{t.notifications.previewExcerpt}</option>
							</select>
						{/if}
					</div>
					<label class="option-row flex items-center justify-between">
						<span class="text-13 text-ink">{t.notifications.deviceBadge}</span>
						<input
							type="checkbox"
							checked={device.badge}
							onchange={(e) => void runtime.patchNotificationDevice({ badge: (e.currentTarget as HTMLInputElement).checked })}
						/>
					</label>
				</div>
			{/if}

			<div class="test-row flex items-center gap-3">
				<button
					type="button"
					class="btn-secondary text-12 px-3 py-1.5 rounded hover:bg-pane-hover cursor-pointer"
					disabled={testBusy || !canSendTest}
					onclick={() => void handleSendTest()}
				>
					{testBusy ? t.notifications.testSubmitting : t.notifications.sendTest}
				</button>
				{#if testFeedback}
					<span class="text-12 text-muted flex-1">{testFeedback}</span>
				{:else if usesNativeTestGate && !runtime.nativeCapabilities.native_delivery_v1}
					<span class="text-12 text-muted flex-1">{t.notifications.nativeTestDisabled}</span>
				{/if}
			</div>
		</div>
	</section>
</div>

<style>
	.settings-card {
		padding: 16px;
		background: var(--pane);
		border: 1px solid var(--line);
		border-radius: var(--radius-md, 8px);
	}
	.category-toggle-item,
	.quiet-hours-body label,
	.time-inputs,
	.health-notice,
	.device-body > label,
	.device-options {
		border: 1px solid var(--line);
	}
	.feedback-msg {
		border: 1px solid var(--line);
	}
	.time-picker,
	.device-options select,
	.btn-secondary {
		border: 1px solid var(--line);
	}
	.time-picker {
		min-height: 32px;
	}
	@media (max-width: 680px) {
		.category-grid {
			grid-template-columns: 1fr;
		}
	}
</style>
