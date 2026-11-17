<script lang="ts">
	import SettingsCard from './SettingsCard.svelte';
	import BrandMark from '../BrandMark.svelte';
	import type { Copy } from '../copy.ts';
	import { updateChecker } from '../update-checker.svelte.ts';

	type Props = {
		t: Copy;
	};

	let { t }: Props = $props();
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
					<span class="about-version-chip inline-block font-mono text-12 text-muted">{t.settings.version(updateChecker.version ?? '0.5.1')}</span>
				</span>
			</div>
		</div>
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

	.about-identity {
		display: flex;
		align-items: center;
		gap: 14px;
	}

	@media (max-width: 720px) {
		.settings-tab-pane {
			gap: 12px;
		}
	}
</style>
