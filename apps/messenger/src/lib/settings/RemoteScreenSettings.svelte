<script lang="ts" module>
	import type { RemoteScreenIceServer } from '@real-bot/protocol';

	/** One server per line: the URL, then for a TURN server its username and credential. */
	export function parseIceLines(text: string): RemoteScreenIceServer[] | null {
		const servers: RemoteScreenIceServer[] = [];
		for (const raw of text.split('\n')) {
			const line = raw.trim();
			if (!line) continue;
			const [url, username, credential, ...rest] = line.split(/\s+/);
			if (!url || rest.length || !/^(stun|stuns|turn|turns):\S+$/.test(url)) return null;
			servers.push({ urls: [url], ...(username ? { username } : {}), ...(credential ? { credential } : {}) });
		}
		return servers;
	}

	export function iceLines(servers: RemoteScreenIceServer[]): string {
		return servers
			.flatMap((server) => server.urls.map((url) => [url, server.username, server.credential].filter(Boolean).join(' ')))
			.join('\n');
	}
</script>

<script lang="ts">
	import type { RemoteScreenStatus } from '@real-bot/protocol';
	import type { Copy } from '../copy.ts';
	import SettingsSwitch from './SettingsSwitch.svelte';
	import type { LocalApi } from '../local-api.ts';
	import { desktopPlatform } from '../platform.ts';
	import { isTauri, readTauriInternals } from '../tauri.ts';

	/**
	 * The Mac's half of the remote screen: whether paired devices may view and control it, whether
	 * macOS Screen Sharing is there to serve them, which ICE servers a direct connection may use,
	 * and who is connected now. Reachable only from this window: no paired device can change it.
	 * On Windows the server is a VNC server the person installs (ADR 0059): while none answers, the
	 * card says how to set TightVNC up and links its download page instead of macOS's Sharing pane.
	 */
	interface Props {
		api: LocalApi;
		t: Copy;
		/** How often the card looks again while open: someone may connect, or Screen Sharing be turned on. */
		pollMs?: number;
		/** The OS this window runs on; read from the webview unless a test says. */
		windows?: boolean;
	}

	let { api, t, pollMs = 5000, windows = desktopPlatform() === 'windows' }: Props = $props();

	let status = $state<RemoteScreenStatus | null>(null);
	let busy = $state(false);
	let failed = $state(false);
	let iceText = $state('');
	let iceDirty = $state(false);
	let iceInvalid = $state(false);

	async function load(): Promise<void> {
		try {
			const next = await api.remoteScreen();
			status = next;
			failed = false;
			if (!iceDirty) iceText = iceLines(next.iceServers);
		} catch {
			failed = true;
		}
	}

	async function update(body: Parameters<LocalApi['setRemoteScreen']>[0]): Promise<void> {
		busy = true;
		try {
			status = await api.setRemoteScreen(body);
			failed = false;
		} catch {
			failed = true;
		} finally {
			busy = false;
		}
	}

	async function saveIce(): Promise<void> {
		const servers = parseIceLines(iceText);
		iceInvalid = servers === null;
		if (!servers) return;
		await update({ iceServers: servers });
		if (!failed) iceDirty = false;
	}

	async function disconnect(): Promise<void> {
		busy = true;
		try {
			status = await api.disconnectRemoteScreen();
		} catch {
			failed = true;
		} finally {
			busy = false;
		}
	}

	/**
	 * System Settings' Sharing pane (the window's opener allows this one settings address and no
	 * other), or on Windows TightVNC's download page.
	 */
	async function openSharing(): Promise<void> {
		const internals = readTauriInternals();
		if (!isTauri(internals) || !internals?.invoke) return;
		const url = windows ? 'https://www.tightvnc.com/download.php' : 'x-apple.systempreferences:com.apple.Sharing-Settings.extension';
		try {
			await internals.invoke('open_external_url', { url });
		} catch {
			// Nothing to fall back to: the description already names where the switch is.
		}
	}

	$effect(() => {
		void load();
		const timer = setInterval(() => void load(), pollMs);
		return () => clearInterval(timer);
	});
</script>

<div class="remote-screen-settings" data-testid="remote-screen">
	<div class="settings-row">
		<div class="settings-row-info">
			<span class="settings-row-title" id="remote-screen-label">{t.screen.macToggle}</span>
			<span class="settings-row-desc">{t.screen.macToggleDesc}</span>
		</div>
		<div class="settings-row-action">
			<SettingsSwitch class="relative inline-flex items-center cursor-pointer select-none" for="remote-screen-toggle" labelledby="remote-screen-label">
				<input
					id="remote-screen-toggle"
					type="checkbox"
					checked={status?.enabled ?? false}
					disabled={busy || !status}
					onchange={(event) => {
						const input = event.currentTarget as HTMLInputElement;
						const enabled = input.checked;
						input.checked = status?.enabled ?? false;
						void update({ enabled });
					}}
				/>
			</SettingsSwitch>
		</div>
	</div>
	{#if failed}
		<p class="field-error">{t.screen.macFailed}</p>
	{/if}
	{#if status?.enabled}
		<div class="remote-screen-sharing">
			<span class={status.sharing ? 'muted' : 'field-error'} data-testid="remote-screen-sharing">
				{status.sharing ? t.screen.macSharingOn : t.screen.macSharingOff}
			</span>
			{#if !status.sharing}
				<button type="button" class="btn-xs" onclick={() => void openSharing()}>{t.screen.macSharingSettings}</button>
			{/if}
		</div>
		{#if windows && !status.sharing}
			<p class="settings-row-desc remote-screen-vnc" data-testid="remote-screen-vnc">{t.screen.macVncSteps}</p>
		{/if}
		{#each status.sessions as session (session.deviceId)}
			<div class="remote-screen-active" role="status">
				<span>
					{t.screen.macActive(session.deviceName, session.mode === 'relay' ? t.screen.relay : session.mode === 'direct' ? t.screen.direct : t.screen.connecting)}
					<span class="remote-screen-traffic" data-testid="remote-screen-traffic">
						{t.screen.macTraffic((session.toPhone / (1024 * 1024)).toFixed(1), session.framebuffer ? `${session.framebuffer.width}×${session.framebuffer.height}` : null)}
					</span>
				</span>
				<button type="button" class="btn-danger-xs" disabled={busy} onclick={() => void disconnect()}>{t.screen.macDisconnect}</button>
			</div>
		{/each}
		{#if status.lowered}
			<p class="muted remote-screen-lowered" data-testid="remote-screen-lowered">
				{t.screen.macLowered(`${status.lowered.width}×${status.lowered.height}`, `${status.lowered.fromWidth}×${status.lowered.fromHeight}`)}
			</p>
		{/if}
		{#if status.direct}
			<div class="remote-screen-ice">
				<label class="settings-row-title" for="remote-screen-ice">{t.screen.macIceServers}</label>
				<span class="settings-row-desc">{t.screen.macIceServersDesc}</span>
				<textarea
					id="remote-screen-ice"
					rows="3"
					spellcheck="false"
					bind:value={iceText}
					oninput={() => { iceDirty = true; iceInvalid = false; }}
				></textarea>
				<div class="remote-screen-ice-actions">
					{#if iceInvalid}<p class="field-error">{t.screen.macIceInvalid}</p>{/if}
					<button type="button" class="btn-xs" disabled={busy || !iceDirty} onclick={() => void saveIce()}>{t.screen.macIceSave}</button>
				</div>
			</div>
		{/if}
	{/if}
</div>

<style>
	.remote-screen-settings {
		display: flex;
		flex-direction: column;
		gap: 8px;
		margin-top: 12px;
		padding-top: 4px;
		border-top: 1px solid var(--line-subtle);
	}

	/* The settings panel's row, as NotificationSettings carries it: styles are scoped. */
	.settings-row {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 16px;
		padding: 12px 2px;
		box-sizing: border-box;
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

	/* `SettingsSwitch`, dimmed here by its checkbox's `disabled` rather than by `is-disabled`. */
	.remote-screen-settings :global(.switch-toggle input:disabled + .switch-track) {
		opacity: 0.55;
		cursor: not-allowed;
	}

	.remote-screen-ice {
		display: flex;
		flex-direction: column;
		gap: 4px;
		padding: 4px 2px 0;
	}

	.remote-screen-ice-actions {
		display: flex;
		align-items: center;
		justify-content: flex-end;
		gap: 8px;
	}

	.remote-screen-ice-actions .field-error {
		margin: 0;
		margin-right: auto;
	}

	.remote-screen-sharing,
	.remote-screen-active {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 8px;
		font-size: 13px;
	}

	.remote-screen-lowered {
		margin: 0;
		font-size: 12px;
		line-height: 1.4;
	}

	.remote-screen-traffic {
		display: block;
		color: var(--muted);
		font-size: 12px;
	}

	.remote-screen-active {
		padding: 8px 10px;
		border: 1px solid var(--accent-border);
		border-radius: var(--radius-sm);
		background: var(--accent-tint);
	}

	textarea {
		width: 100%;
		box-sizing: border-box;
		margin-top: 4px;
		padding: 6px 8px;
		border: 1px solid var(--line);
		border-radius: var(--radius-sm);
		background: var(--input-bg);
		color: var(--ink);
		font-family: var(--mono);
		font-size: 12px;
		resize: vertical;
	}
</style>
