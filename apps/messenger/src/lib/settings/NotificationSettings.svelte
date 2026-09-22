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

	const locale = $derived(runtime.snapshot.settings.locale === 'en' ? 'en' : 'zh');

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

	const categoryList = $derived<Array<{
		key: keyof NotificationPolicyCategories;
		label: string;
		desc: string;
		checked: boolean;
	}>>([
		{
			key: 'approval',
			label: t.notifications.catApproval,
			desc: locale === 'en' ? 'Bot requests tool or action permission approval' : 'Bot 请求工具或操作权限审批时',
			checked: policy?.categories.approval ?? true
		},
		{
			key: 'ask',
			label: t.notifications.catAsk,
			desc: locale === 'en' ? 'Bot asks a question waiting for your answer' : 'Bot 遇到疑问等待你的答复时',
			checked: policy?.categories.ask ?? true
		},
		{
			key: 'failure',
			label: t.notifications.catFailure,
			desc: locale === 'en' ? 'A background task or tool call fails' : '后台任务或工具调用执行失败时',
			checked: policy?.categories.failure ?? true
		},
		{
			key: 'interrupted',
			label: t.notifications.catInterrupted,
			desc: locale === 'en' ? 'An active conversation turn is interrupted' : '会话轮次被人工或系统中断时',
			checked: policy?.categories.interrupted ?? true
		},
		{
			key: 'reply',
			label: t.notifications.catReply,
			desc: locale === 'en' ? 'A message is directly addressed to you' : '收到专门面向你的新消息或回复时',
			checked: policy?.categories.reply ?? true
		},
		{
			key: 'routine_result',
			label: t.notifications.catRoutineResult,
			desc: locale === 'en' ? 'A scheduled routine completes and outputs' : '定时例程完成执行并产出结果时',
			checked: policy?.categories.routine_result ?? true
		}
	]);

	const activeCategoryCount = $derived(
		policy ? Object.values(policy.categories).filter(Boolean).length : 0
	);
</script>

{#snippet categoryIcon(key: keyof NotificationPolicyCategories)}
	{#if key === 'approval'}
		<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
			<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"></path>
			<polyline points="9 12 11 14 15 10"></polyline>
		</svg>
	{:else if key === 'ask'}
		<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
			<circle cx="12" cy="12" r="10"></circle>
			<path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"></path>
			<line x1="12" y1="17" x2="12.01" y2="17"></line>
		</svg>
	{:else if key === 'failure'}
		<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
			<circle cx="12" cy="12" r="10"></circle>
			<line x1="12" y1="8" x2="12" y2="12"></line>
			<line x1="12" y1="16" x2="12.01" y2="16"></line>
		</svg>
	{:else if key === 'interrupted'}
		<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
			<circle cx="12" cy="12" r="10"></circle>
			<line x1="10" y1="15" x2="10" y2="9"></line>
			<line x1="14" y1="15" x2="14" y2="9"></line>
		</svg>
	{:else if key === 'reply'}
		<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
			<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path>
		</svg>
	{:else if key === 'routine_result'}
		<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
			<rect x="3" y="4" width="18" height="18" rx="2" ry="2"></rect>
			<line x1="16" y1="2" x2="16" y2="6"></line>
			<line x1="8" y1="2" x2="8" y2="6"></line>
			<line x1="3" y1="10" x2="21" y2="10"></line>
			<polyline points="9 16 11 18 15 14"></polyline>
		</svg>
	{/if}
{/snippet}

<div class="notification-settings settings-tab-pane">
	<!-- Categories Section -->
	<section class="settings-card">
		<div class="settings-card-header">
			<div class="settings-card-header-main">
				<div class="settings-header-icon-wrap" aria-hidden="true">
					<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
						<rect x="3" y="3" width="7" height="7"></rect>
						<rect x="14" y="3" width="7" height="7"></rect>
						<rect x="14" y="14" width="7" height="7"></rect>
						<rect x="3" y="14" width="7" height="7"></rect>
					</svg>
				</div>
				<div>
					<h3 class="settings-card-title">{t.notifications.sectionCategories}</h3>
					<p class="settings-card-subtitle">{t.notifications.categoriesSubtitle}</p>
				</div>
			</div>
			{#if policy}
				<span class="settings-badge-ok">
					{activeCategoryCount} / 6
				</span>
			{/if}
		</div>

		<div class="category-grid">
			{#each categoryList as cat (cat.key)}
				<label class="category-toggle-item" class:is-checked={cat.checked}>
					<div class="category-main">
						<div class="category-icon-wrap category-icon-{cat.key}" aria-hidden="true">
							{@render categoryIcon(cat.key)}
						</div>
						<div class="category-info">
							<span class="category-title">{cat.label}</span>
							<span class="category-desc">{cat.desc}</span>
						</div>
					</div>
					<div class="category-action">
						<span class="switch-toggle" class:is-disabled={policyLoading}>
							<input
								type="checkbox"
								checked={cat.checked}
								disabled={policyLoading}
								onchange={() => void toggleCategory(cat.key)}
							/>
							<span class="switch-track" aria-hidden="true">
								<span class="switch-thumb"></span>
							</span>
						</span>
					</div>
				</label>
			{/each}
		</div>
	</section>

	<!-- Quiet Hours Section -->
	<section class="settings-card">
		<div class="settings-card-header">
			<div class="settings-card-header-main">
				<div class="settings-header-icon-wrap" aria-hidden="true">
					<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
						<path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"></path>
					</svg>
				</div>
				<div>
					<h3 class="settings-card-title">{t.notifications.quietHours}</h3>
					<p class="settings-card-subtitle">{t.notifications.quietHoursSubtitle}</p>
				</div>
			</div>
			<span class={policy?.quiet_hours.enabled ? 'settings-badge-ok' : 'settings-badge-neutral'}>
				{policy?.quiet_hours.enabled ? (locale === 'en' ? 'Active' : '已生效') : (locale === 'en' ? 'Disabled' : '未开启')}
			</span>
		</div>

		<div class="quiet-hours-body">
			<div class="settings-rows">
				<label class="settings-row quiet-hours-toggle-row">
					<div class="settings-row-info">
						<span class="settings-row-title">{t.notifications.quietHoursEnabled}</span>
						<span class="settings-row-desc">
							{locale === 'en'
								? 'Suppress external banners and sounds during this window'
								: '在指定时段内抑制系统通知横幅与提示音，会话列表保留待办'}
						</span>
					</div>
					<div class="settings-row-action">
						<span class="switch-toggle" class:is-disabled={policyLoading}>
							<input
								type="checkbox"
								checked={policy?.quiet_hours.enabled ?? false}
								disabled={policyLoading}
								onchange={() => void toggleQuietHours()}
							/>
							<span class="switch-track" aria-hidden="true">
								<span class="switch-thumb"></span>
							</span>
						</span>
					</div>
				</label>
			</div>

			{#if policy?.quiet_hours.enabled}
				<div class="time-inputs-panel time-inputs">
					<div class="time-inputs-wrap">
						<div class="time-picker-card">
							<span class="time-picker-label">{t.notifications.quietHoursStart}</span>
							<div class="time-picker-input-wrap">
								<svg class="time-picker-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
									<circle cx="12" cy="12" r="10"></circle>
									<polyline points="12 6 12 12 16 14"></polyline>
								</svg>
								<input
									id="quiet-hours-start"
									type="time"
									class="time-picker"
									value={policy.quiet_hours.start}
									onchange={(e) => void updateQuietHoursTimes((e.currentTarget as HTMLInputElement).value, policy.quiet_hours.end)}
								/>
							</div>
						</div>

						<div class="time-range-separator" aria-hidden="true">
							<span class="time-separator-text">至</span>
							<svg class="time-separator-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
								<line x1="5" y1="12" x2="19" y2="12"></line>
								<polyline points="12 5 19 12 12 19"></polyline>
							</svg>
						</div>

						<div class="time-picker-card">
							<span class="time-picker-label">{t.notifications.quietHoursEnd}</span>
							<div class="time-picker-input-wrap">
								<svg class="time-picker-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
									<circle cx="12" cy="12" r="10"></circle>
									<polyline points="12 6 12 12 16 14"></polyline>
								</svg>
								<input
									id="quiet-hours-end"
									type="time"
									class="time-picker"
									value={policy.quiet_hours.end}
									onchange={(e) => void updateQuietHoursTimes(policy.quiet_hours.start, (e.currentTarget as HTMLInputElement).value)}
								/>
							</div>
						</div>
					</div>

					{#if policy.quiet_hours.time_zone}
						<div class="timezone-badge">
							<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
								<circle cx="12" cy="12" r="10"></circle>
								<line x1="2" y1="12" x2="22" y2="12"></line>
								<path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"></path>
							</svg>
							<span class="timezone-label">{t.notifications.quietHoursTimeZone}:</span>
							<span class="timezone-value font-mono">{policy.quiet_hours.time_zone}</span>
						</div>
					{/if}

					{#if quietHoursError}
						<div class="quiet-hours-error-alert" role="alert">
							<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
								<circle cx="12" cy="12" r="10"></circle>
								<line x1="12" y1="8" x2="12" y2="12"></line>
								<line x1="12" y1="16" x2="12.01" y2="16"></line>
							</svg>
							<span>{quietHoursError}</span>
						</div>
					{/if}
				</div>
			{/if}
		</div>
	</section>

	<!-- Device Notifications Section -->
	<section class="settings-card">
		<div class="settings-card-header">
			<div class="settings-card-header-main">
				<div class="settings-header-icon-wrap" aria-hidden="true">
					<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
						<path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"></path>
						<path d="M13.73 21a2 2 0 0 1-3.46 0"></path>
					</svg>
				</div>
				<div>
					<h3 class="settings-card-title">{t.notifications.deviceNotifications}</h3>
					<p class="settings-card-subtitle">{t.notifications.deviceSubtitle}</p>
				</div>
			</div>
			<span class={device?.enabled ? 'settings-badge-ok' : 'settings-badge-neutral'}>
				{device?.enabled ? t.notifications.deviceEnabled : t.notifications.deviceDisabled}
			</span>
		</div>

		<div class="device-body">
			{#if runtime.isDesktopShell}
				{#if runtime.pushPermission === 'denied'}
					<div class="health-notice is-danger" role="alert">
						<svg class="notice-icon" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
							<circle cx="12" cy="12" r="10"></circle>
							<line x1="12" y1="8" x2="12" y2="12"></line>
							<line x1="12" y1="16" x2="12.01" y2="16"></line>
						</svg>
						<span>{t.notifications.permissionDenied}</span>
					</div>
				{/if}

				<div class="settings-rows">
					<label class="settings-row device-master-row">
						<div class="settings-row-info">
							<span class="settings-row-title">{t.notifications.deviceEnable}</span>
							<span class="settings-row-desc">
								{device?.enabled
									? (locale === 'en' ? 'Desktop native banners and alerts are active' : '通过 macOS 本地横幅与提示音通知')
									: t.notifications.deviceDisabled}
							</span>
						</div>
						<div class="settings-row-action">
							<span class="switch-toggle" class:is-disabled={deviceLoading}>
								<input
									type="checkbox"
									checked={device?.enabled ?? false}
									disabled={deviceLoading}
									onchange={() => void handleDeviceToggle()}
								/>
								<span class="switch-track" aria-hidden="true">
									<span class="switch-thumb"></span>
								</span>
							</span>
						</div>
					</label>
				</div>
			{:else}
				{#if pushHealth === 'unsupported'}
					<div class="health-notice is-muted">
						<svg class="notice-icon" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
							<circle cx="12" cy="12" r="10"></circle>
							<line x1="12" y1="8" x2="12" y2="12"></line>
							<line x1="12" y1="16" x2="12.01" y2="16"></line>
						</svg>
						<span>{t.notifications.pushUnsupported}</span>
					</div>
				{:else if pushHealth === 'install_required'}
					<div class="health-notice is-info">
						<svg class="notice-icon" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
							<path d="M4 16v1a3 3 0 0 0 3 3h10a3 3 0 0 0 3-3v-1"></path>
							<polyline points="16 12 12 8 8 12"></polyline>
							<line x1="12" y1="8" x2="12" y2="21"></line>
						</svg>
						<span>{t.notifications.iosInstallRequired}</span>
					</div>
				{:else if pushHealth === 'denied'}
					<div class="health-notice is-danger" role="alert">
						<svg class="notice-icon" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
							<circle cx="12" cy="12" r="10"></circle>
							<line x1="12" y1="8" x2="12" y2="12"></line>
							<line x1="12" y1="16" x2="12.01" y2="16"></line>
						</svg>
						<span>{t.notifications.permissionDenied}</span>
					</div>
				{:else if pushHealth === 'gated'}
					<div class="health-notice is-warn">
						<svg class="notice-icon" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
							<path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"></path>
							<line x1="12" y1="9" x2="12" y2="13"></line>
							<line x1="12" y1="17" x2="12.01" y2="17"></line>
						</svg>
						<span>{t.notifications.remoteGated}</span>
					</div>
				{:else if pushHealth === 'paused_upgrade'}
					<div class="health-notice is-muted">
						<svg class="notice-icon" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
							<circle cx="12" cy="12" r="10"></circle>
							<polyline points="12 6 12 12 16 14"></polyline>
						</svg>
						<span>{t.notifications.pushUpgrading}</span>
					</div>
				{:else if pushHealth === 'needs_repair'}
					<div class="health-notice is-repair">
						<div class="notice-main">
							<svg class="notice-icon text-warning" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
								<path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"></path>
								<line x1="12" y1="9" x2="12" y2="13"></line>
								<line x1="12" y1="17" x2="12.01" y2="17"></line>
							</svg>
							<span class="text-13 text-warning font-medium">{t.notifications.needsRepair}</span>
						</div>
						<button
							type="button"
							class="btn-repair"
							onclick={() => void runtime.enableDeviceNotifications()}
						>
							{t.notifications.repairButton}
						</button>
					</div>
				{:else}
					<div class="settings-rows">
						<label class="settings-row device-master-row">
							<div class="settings-row-info">
								<span class="settings-row-title">{t.notifications.deviceEnable}</span>
								<span class="settings-row-desc">
									{device?.enabled
										? (locale === 'en' ? 'Web Push delivery is active for this device' : '通过 Web Push 推送在当前设备接收通知')
										: t.notifications.deviceDisabled}
								</span>
							</div>
							<div class="settings-row-action">
								<span class="switch-toggle" class:is-disabled={deviceLoading}>
									<input
										type="checkbox"
										checked={device?.enabled ?? false}
										disabled={deviceLoading}
										onchange={() => void handleDeviceToggle()}
									/>
									<span class="switch-track" aria-hidden="true">
										<span class="switch-thumb"></span>
									</span>
								</span>
							</div>
						</label>
					</div>
				{/if}

				{#if disableFeedback}
					<div class="health-notice is-warn feedback-msg">
						<svg class="notice-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
							<path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"></path>
							<line x1="12" y1="9" x2="12" y2="13"></line>
							<line x1="12" y1="17" x2="12.01" y2="17"></line>
						</svg>
						<span>{disableFeedback}</span>
					</div>
				{/if}
			{/if}

			{#if device?.enabled}
				<div class="device-options settings-rows">
					<div class="settings-row">
						<div class="settings-row-info">
							<span class="settings-row-title">{t.notifications.deviceSound}</span>
							<span class="settings-row-desc">
								{locale === 'en' ? 'Play audio alert when new notification arrives' : '接收到通知时播放系统声音提示'}
							</span>
						</div>
						<div class="settings-row-action">
							{#if runtime.hosted}
								<span class="settings-pill-badge">{locale === 'en' ? 'Managed by system' : '由系统管理'}</span>
							{:else}
								<select
									class="settings-select"
									value={device.sound}
									onchange={(e) => void runtime.patchNotificationDevice({ sound: (e.currentTarget as HTMLSelectElement).value as any })}
								>
									<option value="default">{locale === 'en' ? 'Default' : '默认'}</option>
									<option value="system">{locale === 'en' ? 'System' : '系统'}</option>
									<option value="off">{locale === 'en' ? 'Mute' : '静音'}</option>
								</select>
							{/if}
						</div>
					</div>

					<div class="settings-row">
						<div class="settings-row-info">
							<span class="settings-row-title">{t.notifications.devicePreview}</span>
							<span class="settings-row-desc">
								{locale === 'en' ? 'Information detail visible in banners and lock screen' : '横幅与锁屏通知中展示的内容详细度'}
							</span>
						</div>
						<div class="settings-row-action">
							{#if runtime.hosted}
								<span class="settings-pill-badge">{t.notifications.previewGeneric}</span>
							{:else}
								<select
									class="settings-select"
									value={device.preview}
									onchange={(e) => void runtime.patchNotificationDevice({ preview: (e.currentTarget as HTMLSelectElement).value as any })}
								>
									<option value="generic">{t.notifications.previewGeneric}</option>
									<option value="reply_excerpt">{t.notifications.previewExcerpt}</option>
								</select>
							{/if}
						</div>
					</div>

					<label class="settings-row">
						<div class="settings-row-info">
							<span class="settings-row-title">{t.notifications.deviceBadge}</span>
							<span class="settings-row-desc">
								{locale === 'en' ? 'Show unread count badge on app icon' : '在应用图标或 Dock 上标出未读计数'}
							</span>
						</div>
						<div class="settings-row-action">
							<span class="switch-toggle">
								<input
									type="checkbox"
									checked={device.badge}
									onchange={(e) => void runtime.patchNotificationDevice({ badge: (e.currentTarget as HTMLInputElement).checked })}
								/>
								<span class="switch-track" aria-hidden="true">
									<span class="switch-thumb"></span>
								</span>
							</span>
						</div>
					</label>
				</div>
			{/if}

			<div class="test-row">
				<button
					type="button"
					class="btn-send-test"
					disabled={testBusy || !canSendTest}
					onclick={() => void handleSendTest()}
				>
					{#if testBusy}
						<svg class="animate-spin test-icon" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
							<circle cx="12" cy="12" r="10" stroke-dasharray="32" stroke-dashoffset="10"></circle>
						</svg>
						<span>{t.notifications.testSubmitting}</span>
					{:else}
						<svg class="test-icon" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
							<line x1="22" y1="2" x2="11" y2="13"></line>
							<polygon points="22 2 15 22 11 13 2 9 22 2"></polygon>
						</svg>
						<span>{t.notifications.sendTest}</span>
					{/if}
				</button>

				{#if testFeedback}
					<div class="test-feedback" role="status">
						<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
							<circle cx="12" cy="12" r="10"></circle>
							<polyline points="9 12 11 14 15 10"></polyline>
						</svg>
						<span>{testFeedback}</span>
					</div>
				{:else if usesNativeTestGate && !runtime.nativeCapabilities.native_delivery_v1}
					<span class="test-disabled-hint">{t.notifications.nativeTestDisabled}</span>
				{/if}
			</div>
		</div>
	</section>
</div>

<style>
	.notification-settings {
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
		gap: 14px;
		box-shadow: var(--shadow-xs);
		box-sizing: border-box;
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

	.settings-header-icon-wrap {
		width: 30px;
		height: 30px;
		border-radius: var(--radius-md);
		background: var(--accent-tint);
		color: var(--accent);
		display: flex;
		align-items: center;
		justify-content: center;
		flex-shrink: 0;
	}

	.settings-card-title {
		margin: 0;
		font-size: 13.5px;
		font-weight: 600;
		color: var(--ink);
		line-height: 1.3;
	}

	.settings-card-subtitle {
		margin: 2px 0 0;
		font-size: 11.5px;
		color: var(--muted);
		line-height: 1.35;
	}

	/* Status Badges */
	.settings-badge-ok,
	.settings-badge-neutral,
	.settings-badge-warn {
		display: inline-flex;
		align-items: center;
		padding: 2px 8px;
		border-radius: 9999px;
		font-size: 11px;
		font-weight: 600;
		letter-spacing: 0.01em;
		white-space: nowrap;
		flex-shrink: 0;
	}

	.settings-badge-ok {
		background: var(--ok-bg);
		border: 1px solid var(--ok-line);
		color: var(--ok-text);
	}

	.settings-badge-neutral {
		background: var(--chip);
		border: 1px solid var(--chip-line);
		color: var(--muted);
	}

	.settings-badge-warn {
		background: var(--warn-bg);
		border: 1px solid var(--warn-line);
		color: var(--warn-text);
	}

	.settings-pill-badge {
		font-size: 12px;
		color: var(--muted);
		padding: 4px 8px;
		background: var(--chip);
		border-radius: var(--radius-sm);
	}

	/* Category Grid */
	.category-grid {
		display: grid;
		grid-template-columns: repeat(2, 1fr);
		gap: 10px;
	}

	.category-toggle-item {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 12px;
		padding: 12px 14px;
		border-radius: var(--radius-md);
		background: var(--sidebar-bg);
		border: 1px solid var(--line);
		cursor: pointer;
		user-select: none;
		transition: border-color 0.18s cubic-bezier(0.16, 1, 0.3, 1),
			background-color 0.18s cubic-bezier(0.16, 1, 0.3, 1),
			box-shadow 0.18s cubic-bezier(0.16, 1, 0.3, 1);
		box-sizing: border-box;
	}

	.category-toggle-item:hover {
		border-color: var(--accent-border);
		background: var(--pane);
		box-shadow: var(--shadow-xs);
	}

	.category-toggle-item.is-checked {
		background: var(--pane);
		border-color: var(--line);
	}

	.category-main {
		display: flex;
		align-items: center;
		gap: 10px;
		min-width: 0;
		flex: 1;
	}

	.category-icon-wrap {
		width: 32px;
		height: 32px;
		border-radius: var(--radius-sm);
		display: flex;
		align-items: center;
		justify-content: center;
		flex-shrink: 0;
		transition: transform 0.15s ease;
	}

	.category-icon-approval {
		background: var(--accent-tint);
		color: var(--accent);
	}

	.category-icon-ask {
		background: var(--purple-bg);
		color: var(--purple);
	}

	.category-icon-failure {
		background: var(--danger-bg);
		color: var(--danger);
	}

	.category-icon-interrupted {
		background: var(--warn-bg);
		color: var(--warn);
	}

	.category-icon-reply {
		background: var(--accent-tint);
		color: var(--accent);
	}

	.category-icon-routine_result {
		background: var(--ok-bg);
		color: var(--ok);
	}

	.category-info {
		display: flex;
		flex-direction: column;
		gap: 2px;
		min-width: 0;
		flex: 1;
	}

	.category-title {
		font-size: 13px;
		font-weight: 500;
		color: var(--ink);
		line-height: 1.3;
	}

	.category-desc {
		font-size: 11.5px;
		color: var(--muted);
		line-height: 1.35;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.category-action {
		flex-shrink: 0;
		display: flex;
		align-items: center;
	}

	/* Settings Rows */
	.settings-rows {
		display: flex;
		flex-direction: column;
		border-top: 1px solid var(--line-subtle);
	}

	.settings-row {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 16px;
		padding: 12px 2px;
		border-bottom: 1px solid var(--line-subtle);
		transition: background 0.15s ease;
		box-sizing: border-box;
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
		font-size: 11.5px;
		color: var(--muted);
		line-height: 1.35;
	}

	.settings-row-action {
		display: flex;
		align-items: center;
		flex-shrink: 0;
	}

	/* Switch Toggle (macOS / iOS style) */
	.switch-toggle {
		position: relative;
		display: inline-flex;
		align-items: center;
		cursor: pointer;
		user-select: none;
	}

	.switch-toggle input {
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
		border-radius: 9999px;
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
	}

	.switch-toggle input:checked + .switch-track {
		background: var(--accent);
	}

	.switch-toggle input:checked + .switch-track .switch-thumb {
		transform: translateX(18px);
	}

	.switch-toggle input:focus-visible + .switch-track {
		outline: 2px solid var(--accent);
		outline-offset: 2px;
	}

	.switch-toggle.is-disabled {
		opacity: 0.55;
		cursor: not-allowed;
	}

	/* Quiet Hours */
	.quiet-hours-body {
		display: flex;
		flex-direction: column;
		gap: 12px;
	}

	.time-inputs-panel {
		display: flex;
		flex-direction: column;
		gap: 10px;
		padding: 14px;
		background: var(--sidebar-bg);
		border: 1px solid var(--line);
		border-radius: var(--radius-md);
	}

	.time-inputs-wrap {
		display: flex;
		align-items: center;
		gap: 12px;
	}

	.time-picker-card {
		flex: 1;
		display: flex;
		flex-direction: column;
		gap: 6px;
	}

	.time-picker-label {
		font-size: 11.5px;
		font-weight: 500;
		color: var(--muted);
	}

	.time-picker-input-wrap {
		position: relative;
		display: flex;
		align-items: center;
	}

	.time-picker-icon {
		position: absolute;
		left: 10px;
		color: var(--muted);
		pointer-events: none;
	}

	.time-picker {
		width: 100%;
		min-height: 36px;
		padding: 6px 10px 6px 32px;
		border-radius: var(--radius-sm);
		background: var(--pane);
		border: 1px solid var(--line);
		color: var(--ink);
		font-size: 13px;
		font-family: inherit;
		box-sizing: border-box;
		transition: border-color 0.15s ease, box-shadow 0.15s ease;
	}

	.time-picker:focus {
		outline: none;
		border-color: var(--accent);
		box-shadow: 0 0 0 2px var(--accent-tint);
	}

	.time-range-separator {
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		padding-top: 18px;
		color: var(--muted);
		flex-shrink: 0;
	}

	.time-separator-text {
		font-size: 12px;
		font-weight: 500;
	}

	.time-separator-icon {
		display: none;
	}

	.timezone-badge {
		display: inline-flex;
		align-items: center;
		gap: 5px;
		font-size: 11.5px;
		color: var(--muted);
		padding: 4px 8px;
		border-radius: var(--radius-sm);
		background: var(--chip);
		align-self: flex-start;
	}

	.timezone-val {
		color: var(--ink);
		font-weight: 500;
	}

	.quiet-hours-error-alert {
		display: flex;
		align-items: center;
		gap: 6px;
		font-size: 12px;
		color: var(--danger);
		padding: 6px 10px;
		border-radius: var(--radius-sm);
		background: var(--danger-bg);
		border: 1px solid var(--danger-line);
	}

	/* Device Section */
	.device-body {
		display: flex;
		flex-direction: column;
		gap: 12px;
	}

	.health-notice {
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 10px 12px;
		border-radius: var(--radius-md);
		font-size: 12.5px;
		line-height: 1.4;
		border: 1px solid transparent;
		box-sizing: border-box;
	}

	.health-notice .notice-icon {
		flex-shrink: 0;
	}

	.health-notice.is-danger {
		background: var(--danger-bg);
		border-color: var(--danger-line);
		color: var(--danger-text);
	}

	.health-notice.is-warn {
		background: var(--warn-bg);
		border-color: var(--warn-line);
		color: var(--warn-text);
	}

	.health-notice.is-info {
		background: var(--accent-tint);
		border-color: var(--accent-border);
		color: var(--accent);
	}

	.health-notice.is-muted {
		background: var(--sidebar-bg);
		border-color: var(--line);
		color: var(--muted);
	}

	.health-notice.is-repair {
		background: var(--warn-bg);
		border-color: var(--warn-line);
		justify-content: space-between;
	}

	.health-notice .notice-main {
		display: flex;
		align-items: center;
		gap: 8px;
	}

	.btn-repair {
		padding: 5px 12px;
		font-size: 12px;
		font-weight: 600;
		border-radius: var(--radius-sm);
		background: var(--warn);
		color: #ffffff;
		border: none;
		cursor: pointer;
		transition: opacity 0.15s ease;
	}

	.btn-repair:hover {
		opacity: 0.9;
	}

	.settings-select {
		appearance: none;
		-webkit-appearance: none;
		padding: 6px 28px 6px 10px;
		background: var(--pane) url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 24 24' fill='none' stroke='%2364748b' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpolyline points='6 9 12 15 18 9'%3E%3C/polyline%3E%3C/svg%3E") no-repeat right 8px center;
		border: 1px solid var(--line);
		border-radius: var(--radius-sm);
		color: var(--ink);
		font-size: 12.5px;
		cursor: pointer;
		box-sizing: border-box;
		transition: border-color 0.15s ease;
	}

	.settings-select:focus {
		outline: none;
		border-color: var(--accent);
		box-shadow: 0 0 0 2px var(--accent-tint);
	}

	/* Test Row */
	.test-row {
		display: flex;
		align-items: center;
		gap: 12px;
		padding-top: 4px;
	}

	.btn-send-test {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		padding: 7px 14px;
		font-size: 12.5px;
		font-weight: 500;
		color: var(--ink-secondary);
		background: var(--btn-secondary-bg);
		border: 1px solid var(--line);
		border-radius: var(--radius-md);
		cursor: pointer;
		transition: all 0.15s cubic-bezier(0.16, 1, 0.3, 1);
		box-shadow: var(--shadow-xs);
		flex-shrink: 0;
	}

	.btn-send-test:hover:not(:disabled) {
		background: var(--btn-secondary-hover);
		color: var(--ink);
		border-color: var(--line-hover);
	}

	.btn-send-test:active:not(:disabled) {
		transform: scale(0.98);
	}

	.btn-send-test:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}

	.test-icon {
		flex-shrink: 0;
	}

	.test-feedback {
		display: inline-flex;
		align-items: center;
		gap: 5px;
		font-size: 12px;
		color: var(--ok-text);
		line-height: 1.35;
	}

	.test-disabled-hint {
		font-size: 12px;
		color: var(--muted);
		line-height: 1.35;
	}

	/* Mobile Responsive Styles */
	@media (max-width: 680px) {
		.notification-settings {
			gap: 12px;
		}

		.settings-card {
			padding: 14px 12px;
			border-radius: var(--radius-md);
			gap: 12px;
		}

		.category-grid {
			grid-template-columns: 1fr;
			gap: 8px;
		}

		.category-toggle-item {
			padding: 10px 12px;
			min-height: 52px;
		}

		.time-inputs-panel {
			padding: 12px 10px;
		}

		.time-inputs-wrap {
			gap: 8px;
		}

		.time-picker {
			min-height: 40px;
			font-size: 14px;
		}

		.test-row {
			flex-wrap: wrap;
			gap: 8px;
		}

		.btn-send-test {
			min-height: 38px;
		}
	}

	@media (max-width: 540px) {
		.settings-row {
			padding: 10px 0;
			min-height: 48px;
		}

		.category-desc {
			white-space: normal;
			display: -webkit-box;
			line-clamp: 2;
			-webkit-line-clamp: 2;
			-webkit-box-orient: vertical;
		}

		.time-range-separator {
			padding-top: 16px;
		}
	}
</style>
