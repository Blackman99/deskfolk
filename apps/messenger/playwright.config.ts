import { defineConfig } from '@playwright/test';

/**
 * Visual baselines for the panes, taken against components mounted on their own with fixture
 * data — no daemon, no database. Local only: `pnpm --filter @real-bot/messenger test:visual`.
 * Not wired into CI, because these are system-font renders and a Linux runner would disagree
 * with this machine about every one of them.
 */
export default defineConfig({
	testDir: './tests/visual',
	snapshotPathTemplate: '{testDir}/baseline/{arg}{ext}',
	fullyParallel: true,
	reporter: [['list']],
	use: {
		baseURL: 'http://localhost:5199/tests/visual/',
		viewport: { width: 1000, height: 900 },
		deviceScaleFactor: 1
	},
	expect: {
		/*
		 * Tight on purpose. On this machine two runs of the same story are pixel-identical, so the
		 * only thing this budget has to absorb is future antialiasing jitter — not a change in the
		 * design. A ratio-based budget was the first attempt and it was useless: 0.2% of a
		 * 900×520 shot is 936 pixels, and dropping a dialog corner from 18px to 2px moves 212.
		 */
		toHaveScreenshot: { maxDiffPixels: 20, animations: 'disabled' }
	},
	webServer: {
		command: 'pnpm exec vite --config vite.visual.config.ts',
		url: 'http://localhost:5199/tests/visual/index.html',
		reuseExistingServer: true,
		timeout: 60_000
	}
});
