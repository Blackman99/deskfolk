import { defineConfig, presetWind3 } from 'unocss';

/**
 * The scale this app already draws on, named so utilities can reach it.
 *
 * Colours and radii were tokens before UnoCSS arrived and stay tokens: every utility emits
 * `var(--x)`, so `[data-theme="dark"]` keeps working without a single `dark:` variant.
 *
 * Spacing is a 2px unit because that is what the sheet measures out to — 85% of its pixel values
 * are even, and 8/6/4/10/12 are the five it uses most. Font sizes are listed rather than scaled:
 * there are twenty of them and a third land on a half pixel, so a ratio scale would round the
 * design rather than describe it.
 */
const colors = Object.fromEntries(
	[
		'bg', 'pane', 'sidebar-bg', 'ink', 'ink-secondary', 'muted', 'muted-light',
		'line', 'line-subtle', 'line-hover', 'accent', 'accent-hover', 'accent-active',
		'accent-tint', 'accent-border', 'accent-glow', 'you', 'you-text', 'bot', 'bot-border',
		'bot-text', 'warn', 'warn-bg', 'warn-line', 'warn-text', 'ok', 'ok-bg', 'ok-line',
		'ok-text', 'danger', 'danger-bg', 'danger-line', 'danger-text', 'purple', 'chip',
		'chip-line', 'card', 'card-line', 'thread', 'input-bg', 'btn-secondary-bg',
		'btn-secondary-hover', 'code-bg', 'code-header-bg', 'inline-code-bg',
		'inline-code-border', 'reaction-bg', 'row-hover', 'date-pill-bg', 'date-pill-text',
		'date-pill-border', 'modal-backdrop'
	].map((name) => [name, `var(--${name})`])
);

export default defineConfig({
	presets: [presetWind3({ preflight: false })],
	/*
	 * No border utilities. They set a width against `border-style: none`, and the one preflight
	 * line that fixes that (`*{border-style:solid;border-width:0}`) changes the base for the
	 * whole app — the visual baselines went red on six panes when it was tried. Borders stay in
	 * CSS, which is where this app's borders were already written.
	 */
	blocklist: [/^border($|-)/],
	content: { pipeline: { include: [/\.(svelte|ts)($|\?)/] } },
	theme: {
		colors,
		spacing: Object.fromEntries(
			Array.from({ length: 41 }, (_, i) => [String(i), `${i * 2}px`])
		),
		borderRadius: {
			sm: 'var(--radius-sm)',
			md: 'var(--radius-md)',
			lg: 'var(--radius-lg)',
			xl: 'var(--radius-xl)'
		},
		boxShadow: {
			xs: 'var(--shadow-xs)',
			sm: 'var(--shadow-sm)',
			md: 'var(--shadow-md)',
			lg: 'var(--shadow-lg)',
			sheet: 'var(--shadow-sheet)'
		},
		fontFamily: { sans: 'var(--font)', mono: 'var(--mono)' },
		fontSize: Object.fromEntries(
			[9.5, 10, 10.5, 11, 11.5, 12, 12.5, 13, 13.5, 14, 14.5, 15, 16, 16.5, 18, 20, 22, 24]
				// The pair matters: a bare size makes presetWind3 emit `line-height: 1`, while this
				// codebase inherits the unitless 1.5 from base.css. Pairing keeps `text-*` a pure
				// font-size swap. See the route-log migration.
				.map((px) => [String(px).replace('.', 'p'), [`${px}px`, '1.5'] as [string, string]])
		)
	}
});
