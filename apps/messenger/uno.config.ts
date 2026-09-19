import { defineConfig, presetWind3 } from 'unocss';

/**
 * The scale this app already draws on, named so utilities can reach it.
 *
 * Colours and radii were tokens before UnoCSS arrived and stay tokens: every utility emits
 * `var(--x)`, so `[data-theme="dark"]` keeps working without a single `dark:` variant.
 *
 * Spacing is a 2px unit because that is what the sheet measures out to — 85% of its pixel values
 * are even, and 8/6/4/10/12 are the five it uses most.
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

/** The sizes the sheet actually uses; a third land on a half pixel, so they are listed, not scaled. */
const SIZES = new Set(
	['9.5', '10', '10.5', '11', '11.5', '12', '12.5', '13', '13.5', '14', '14.5', '15', '16', '16.5', '18', '20', '22', '24']
);

/** One step is 2px, and every numeric utility measures in it. */
const SCALE = Object.fromEntries(Array.from({ length: 41 }, (_, i) => [String(i), `${i * 2}px`]));

export default defineConfig({
	presets: [presetWind3({ preflight: false })],
	/*
	 * No border utilities. They set a width against `border-style: none`, and the one preflight
	 * line that fixes that (`*{border-style:solid;border-width:0}`) changes the base for the
	 * whole app — the visual baselines went red on six panes when it was tried. Borders stay in
	 * CSS, which is where this app's borders were already written.
	 */
	blocklist: [/^border($|-)/],
	/*
	 * `text-<size>` sets the font size and nothing else.
	 *
	 * presetWind3's own `text-*` always emits a line-height alongside — `1` for a bare theme
	 * entry, or whatever the entry pairs with it. Either way it overrides what the element would
	 * have inherited, and this sheet leans on inheritance in both directions: most text takes the
	 * unitless 1.5 from `base.css`, while the cards that set their own `line-height: 1` expect
	 * their children to keep it. A paired value fixes the first case and breaks the second (the
	 * thinking line inside a replying card went from 11.5px to 17.25px). A bare font-size rule is
	 * a faithful stand-in for the declaration it replaces, which is the whole point.
	 */
	rules: [
		[
			/^text-(\d+(?:p\d)?)$/,
			([, raw]) => {
				const px = raw!.replace('p', '.');
				return SIZES.has(px) ? { 'font-size': `${px}px` } : undefined;
			}
		]
	],
	content: { pipeline: { include: [/\.(svelte|ts)($|\?)/] } },
	theme: {
		colors,
		spacing: SCALE,
		/*
		 * presetWind3 sizes `w-4` off its own 0.25rem step, so without these `p-17` is 34px while
		 * `w-17` is 68px — two scales behind one set of names. One scale, or none.
		 */
		width: SCALE,
		height: SCALE,
		minWidth: SCALE,
		minHeight: SCALE,
		maxWidth: SCALE,
		maxHeight: SCALE,
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
		// No `fontSize` here on purpose — see the `text-*` rule below.
	}
});
