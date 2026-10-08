<script lang="ts">
	import SettingsCard from './SettingsCard.svelte';
	import BrandMark from '../BrandMark.svelte';
	import type { Copy } from '../copy.ts';
	import { updateChecker } from '../update-checker.svelte.ts';
	import {
		formatBytes,
		installErrorCopyKey,
		installPercent,
		installPhaseCopyKey
	} from '../updates.ts';
	import { localeSection, releaseNoteGroups } from './release-notes.ts';

	type Props = {
		t: Copy;
		locale: 'zh' | 'en';
	};

	let { t, locale }: Props = $props();

	/** What the release body says changed, drawn in the About card instead of only linked to. */
	const updateChanges = $derived(
		releaseNoteGroups(localeSection(updateChecker.result?.notes, locale))
	);
	/** The in-app download and swap, as the card draws it: phase, bar, failure. */
	const installPhaseKey = $derived(installPhaseCopyKey(updateChecker.install.phase));
	const installLabel = $derived(installPhaseKey ? t.settings[installPhaseKey] : '');
	const installPercentValue = $derived(installPercent(updateChecker.install));
	const installErrorLabel = $derived(t.settings[installErrorCopyKey(updateChecker.install.error)]);
</script>

<div class="settings-tab-pane">
	<SettingsCard class="settings-card-about">
		<!-- One block: the pane is already titled About, so the card leads with the app itself. -->
		<div class="about-identity">
			<BrandMark size={44} />
			<div class="settings-row-info">
				<h3 class="settings-card-title">Deskfolk</h3>
				<span class="settings-row-desc">{t.settings.aboutDescription}</span>
				<span class="settings-row-desc">
					<span class="about-version-chip inline-block font-mono text-12 text-muted">{t.settings.version(updateChecker.version ?? '0.1.0-rc.14')}</span>
				</span>
			</div>
			{#if updateChecker.available}
				<div class="settings-row-action">
					<button
						type="button"
						class="btn-check-update"
						disabled={updateChecker.status === 'checking'}
						onclick={() => void updateChecker.checkNow()}
					>
						{#if updateChecker.status === 'checking'}
							<svg class="spin-icon" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
								<circle cx="12" cy="12" r="10" stroke-opacity="0.25"></circle>
								<path d="M12 2a10 10 0 0 1 10 10" stroke="currentColor"></path>
							</svg>
						{/if}
						<span>{updateChecker.status === 'checking' ? t.settings.checkingUpdates : t.settings.checkUpdates}</span>
					</button>
				</div>
			{/if}
		</div>

		{#if updateChecker.available}
			{#if updateChecker.status === 'error'}
				<div class="about-status-banner is-error mt-5 py-4 px-6 rounded-md text-12">
					<p class="about-status-text m-0 leading-[1.4]">{t.settings.updateFailed}</p>
				</div>
			{:else if updateChecker.result?.updateAvailable && updateChecker.result.latest}
				<div class="about-update-banner">
					<p class="about-update-title m-0 text-13 font-semibold text-accent">{t.settings.updateAvailable(updateChecker.result.latest)}</p>
					{#if updateChanges.length > 0}
						<div class="about-notes">
							<p class="about-notes-title">{t.settings.updateChanges}</p>
							{#each updateChanges as group, groupIndex (groupIndex)}
								{#if group.heading}
									<p class="about-notes-heading">{group.heading}</p>
								{/if}
								<ul class="about-notes-list">
									{#each group.items as item, itemIndex (itemIndex)}
										<li>{item}</li>
									{/each}
								</ul>
							{/each}
						</div>
					{/if}
					{#if updateChecker.installing}
						<div class="about-install">
							<div class="about-install-head">
								<span class="about-install-phase">{installLabel}</span>
								{#if updateChecker.install.total}
									<span class="about-install-bytes">
										{formatBytes(updateChecker.install.downloaded)} / {formatBytes(updateChecker.install.total)}
									</span>
								{/if}
							</div>
							<div
								class="about-progress"
								role="progressbar"
								aria-label={installLabel}
								aria-valuemin={0}
								aria-valuemax={100}
								aria-valuenow={installPercentValue ?? undefined}
							>
								<div
									class="about-progress-fill"
									class:is-indeterminate={installPercentValue === null}
									style={installPercentValue === null
										? undefined
										: `width: ${installPercentValue}%`}
								></div>
							</div>
							{#if updateChecker.install.phase === 'downloading'}
								<button
									type="button"
									class="btn-text-action self-start"
									onclick={() => void updateChecker.cancelInstall()}
								>
									{t.settings.updateInstallCancel}
								</button>
							{/if}
						</div>
					{:else}
						{#if updateChecker.install.phase === 'failed'}
							<div class="about-install-failed">
								<p class="m-0 text-12 leading-[1.4]">{installErrorLabel}</p>
								{#if updateChecker.install.detail}
									<p class="about-install-detail">{updateChecker.install.detail}</p>
								{/if}
							</div>
						{/if}
						<div class="about-actions flex items-center flex-wrap gap-4">
							{#if updateChecker.installable}
								<button type="button" class="btn-xs btn-primary" onclick={() => void updateChecker.startInstall()}>
									{updateChecker.install.phase === 'failed'
										? t.settings.updateInstallRetry
										: t.settings.updateInstall}
								</button>
							{/if}
							{#if updateChecker.result.downloadUrl}
								<button
									type="button"
									class="btn-xs"
									class:btn-primary={!updateChecker.installable}
									onclick={() => void updateChecker.download()}
								>
									{t.settings.updateDownload}
								</button>
							{/if}
							{#if updateChecker.result.releaseUrl}
								<button type="button" class="btn-xs" onclick={() => void updateChecker.openNotes()}>
									{t.settings.updateNotes}
								</button>
							{/if}
							{#if updateChecker.ignoredVersion !== updateChecker.result.latest}
								<button type="button" class="btn-text-action" onclick={() => updateChecker.ignoreLatest()}>
									{t.settings.updateIgnore}
								</button>
							{/if}
						</div>
						{#if updateChecker.installable && updateChecker.install.phase !== 'failed'}
							<p class="about-install-hint">{t.settings.updateInstallHint}</p>
						{/if}
					{/if}
				</div>
			{:else if updateChecker.status === 'ok'}
				<div class="about-status-banner is-ok mt-5 py-4 px-6 rounded-md text-12">
					<p class="about-status-text m-0 leading-[1.4]">{t.settings.upToDate}</p>
				</div>
			{/if}
		{/if}
	</SettingsCard>
</div>

<style>
	.settings-tab-pane {
		display: flex;
		flex-direction: column;
		gap: 14px;
	}

	.settings-row-info {
		display: flex;
		flex-direction: column;
		gap: 2px;
		min-width: 0;
		flex: 1;
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

	.btn-check-update {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		padding: 5px 12px;
		font-size: 12px;
		font-weight: 500;
		color: var(--ink-secondary);
		background: var(--btn-secondary-bg);
		border: 1px solid var(--line);
		border-radius: var(--radius-md);
		cursor: pointer;
		box-shadow: var(--shadow-xs);
		transition: 0.15s ease;
		transition-property: var(--transition-props);
	}

	.btn-check-update:hover:not(:disabled) {
		background: var(--line-subtle);
		border-color: var(--line-hover);
		color: var(--ink);
	}

	.btn-check-update:disabled {
		opacity: 0.65;
		cursor: not-allowed;
	}

	.spin-icon {
		animation: spin 1s linear infinite;
	}

	.about-identity {
		display: flex;
		align-items: center;
		gap: 14px;
	}

	.about-status-banner.is-ok {
		background: var(--ok-bg);
		border: 1px solid var(--ok-line);
		color: var(--ok);
	}

	.about-status-banner.is-error {
		background: var(--warn-bg);
		border: 1px solid var(--warn-line);
		color: var(--warn-text);
	}

	.about-update-banner {
		margin-top: 10px;
		padding: 10px 12px;
		border-radius: var(--radius-md);
		background: var(--accent-tint);
		border: 1px solid var(--accent-border);
		display: flex;
		flex-direction: column;
		gap: 8px;
	}

	/* The in-app download: the phase on the left, how far along on the right, one bar under both. */
	.about-install {
		display: flex;
		flex-direction: column;
		gap: 6px;
	}

	.about-install-head {
		display: flex;
		align-items: baseline;
		justify-content: space-between;
		gap: 8px;
	}

	.about-install-phase {
		font-size: 12px;
		color: var(--ink-secondary);
	}

	.about-install-bytes {
		font-family: var(--mono);
		font-size: 12px;
		color: var(--muted);
	}

	.about-progress {
		height: 5px;
		border-radius: var(--radius-full);
		background: var(--line-subtle);
		overflow: hidden;
	}

	.about-progress-fill {
		height: 100%;
		width: 0;
		border-radius: var(--radius-full);
		background: var(--accent);
		transition: width 0.2s ease;
	}

	/* No Content-Length to divide by: the bar sweeps instead of claiming a number. */
	.about-progress-fill.is-indeterminate {
		width: 40%;
		animation: about-progress-sweep 1.2s ease-in-out infinite;
	}

	@keyframes about-progress-sweep {
		0% {
			transform: translateX(-110%);
		}
		100% {
			transform: translateX(260%);
		}
	}

	@media (prefers-reduced-motion: reduce) {
		.about-progress-fill.is-indeterminate {
			width: 100%;
			animation: none;
		}
	}

	.about-install-failed {
		display: flex;
		flex-direction: column;
		gap: 4px;
		color: var(--warn-text);
	}

	.about-install-detail {
		margin: 0;
		font-family: var(--mono);
		font-size: 11px;
		line-height: 1.4;
		color: var(--muted);
		overflow-wrap: anywhere;
	}

	.about-install-hint {
		margin: 2px 0 0;
		font-size: 12px;
		line-height: 1.4;
		color: var(--muted);
	}

	/*
	 * The changelog section that came with the check. Long enough to need its own scroll, so it
	 * keeps to a height the card can spare and never pushes the buttons out of reach.
	 */
	.about-notes {
		max-height: 168px;
		overflow-y: auto;
		padding-right: 4px;
		scrollbar-width: thin;
		scrollbar-color: var(--accent-border) transparent;
	}

	.about-notes-title {
		margin: 0 0 4px;
		font-size: 12px;
		font-weight: 600;
		color: var(--ink-secondary);
	}

	.about-notes-heading {
		margin: 8px 0 2px;
		font-size: 11px;
		font-weight: 600;
		color: var(--muted);
	}

	.about-notes-heading:first-of-type {
		margin-top: 0;
	}

	.about-notes-list {
		margin: 0;
		padding-left: 16px;
		display: flex;
		flex-direction: column;
		gap: 3px;
	}

	.about-notes-list li {
		font-size: 12px;
		line-height: 1.45;
		color: var(--ink-secondary);
	}

	@media (max-width: 540px) {
	.settings-row-action {
	width: 100%;
	justify-content: flex-end;
	}
	}

	/* Narrow rows stack, but the mark stays beside the name; only the button drops below. */
	@media (max-width: 540px) {
		.about-identity {
			flex-direction: row;
			flex-wrap: wrap;
			align-items: center;
		}
	}

	@media (max-width: 720px) {
		.settings-tab-pane {
			gap: 12px;
		}
	}

	/* Only the settings modal spins anything; Svelte renames this and the reference together. */
	@keyframes spin {
		from {
			transform: rotate(0deg);
		}
		to {
			transform: rotate(360deg);
		}
	}
</style>
