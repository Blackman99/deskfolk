/**
 * The app's stroke icons, by name. Each is drawn on a 24-unit grid with a 2-unit stroke, round
 * caps and joins (`Icon.svelte` sets those), so any two sit together at any size.
 *
 * New UI takes its icons from here instead of pasting another `<svg>`. The 400-odd inline ones
 * already in components move over when the component around them is reworked, not in a sweep.
 */
export type IconShape =
	| { p: string }
	| { c: [number, number, number] }
	| { r: [number, number, number, number, number] };

/** A shape drawn filled rather than stroked (the dots of "more", the stop square). */
export type FilledIcon = { fill: true; shapes: IconShape[] };

export const ICONS = {
	x: [{ p: 'M6 6l12 12M18 6 6 18' }],
	plus: [{ p: 'M12 5v14M5 12h14' }],
	check: [{ p: 'm5 12.5 4.5 4.5L19 7.5' }],
	'chevron-down': [{ p: 'm6 9 6 6 6-6' }],
	'chevron-up': [{ p: 'm18 15-6-6-6 6' }],
	'chevron-right': [{ p: 'm9 6 6 6-6 6' }],
	'chevron-left': [{ p: 'm15 6-6 6 6 6' }],
	'arrow-up': [{ p: 'M12 19V5M6 11l6-6 6 6' }],
	'arrow-down': [{ p: 'M12 5v14M6 13l6 6 6-6' }],
	'arrow-right': [{ p: 'M5 12h14M13 6l6 6-6 6' }],
	pin: [{ p: 'M12 16v5M8.5 3.5h7l-1 5.5 3 3V14h-11v-2l3-3z' }],
	archive: [{ r: [3, 4, 18, 5, 1.5] }, { p: 'M5 9v8.5A2.5 2.5 0 0 0 7.5 20h9a2.5 2.5 0 0 0 2.5-2.5V9M10 13h4' }],
	reply: [{ p: 'M9 15 4 10l5-5' }, { p: 'M4 10h10a6 6 0 0 1 6 6v3' }],
	copy: [{ r: [9, 9, 11, 11, 2.5] }, { p: 'M15 9V6.5A2.5 2.5 0 0 0 12.5 4h-6A2.5 2.5 0 0 0 4 6.5v6A2.5 2.5 0 0 0 6.5 15H9' }],
	'smile-plus': [{ c: [11, 13, 8] }, { p: 'M8 15s1.2 1.5 3 1.5 3-1.5 3-1.5M8.5 10.5h.01M13.5 10.5h.01' }, { p: 'M19 2v5M16.5 4.5h5' }],
	'shield-check': [{ p: 'M12 3 19 6v5.5c0 4.4-2.9 7.6-7 9.5-4.1-1.9-7-5.1-7-9.5V6z' }, { p: 'm9 12 2 2 4-4' }],
	'help-circle': [{ c: [12, 12, 9] }, { p: 'M9.5 9.5a2.6 2.6 0 0 1 5 1c0 1.7-2.5 2.2-2.5 3.8M12 17.5h.01' }],
	'alert-circle': [{ c: [12, 12, 9] }, { p: 'M12 8v5M12 16.5h.01' }],
	terminal: [{ p: 'm5 8 4 4-4 4M12 16h7' }],
	flow: [{ c: [6, 6, 2.2] }, { c: [6, 18, 2.2] }, { c: [18, 12, 2.2] }, { p: 'M6 8.2v7.6M8.2 6h1.8a6 6 0 0 1 6 4M8.2 18h1.8a6 6 0 0 0 6-4' }],
	file: [{ p: 'M14 3H7.5A2.5 2.5 0 0 0 5 5.5v13A2.5 2.5 0 0 0 7.5 21h9a2.5 2.5 0 0 0 2.5-2.5V8z' }, { p: 'M14 3v5h5' }],
	folder: [{ p: 'M3 7.5A2.5 2.5 0 0 1 5.5 5H9l2 2h7.5A2.5 2.5 0 0 1 21 9.5v7a2.5 2.5 0 0 1-2.5 2.5h-13A2.5 2.5 0 0 1 3 16.5z' }],
	sliders: [{ p: 'M4 7h9M17 7h3M4 17h3M11 17h9' }, { c: [15, 7, 2] }, { c: [9, 17, 2] }],
	search: [{ c: [11, 11, 7] }, { p: 'm20 20-3.5-3.5' }],
	'user-plus': [{ c: [10, 8, 4] }, { p: 'M3 20a7 7 0 0 1 14 0M19 8v6M16 11h6' }],
	users: [{ c: [9, 8, 3.5] }, { p: 'M3 20a6 6 0 0 1 12 0' }, { c: [17, 9, 2.5] }, { p: 'M16 14.2a5 5 0 0 1 5 4.8' }],
	sparkle: [{ p: 'M12 3.5 13.7 9 19 10.5 13.7 12 12 17.5 10.3 12 5 10.5 10.3 9z' }],
	refresh: [{ p: 'M21 12a9 9 0 1 1-6.2-8.6' }, { p: 'M21 4v5h-5' }],
	spinner: [{ p: 'M21 12a9 9 0 1 1-6.2-8.6' }],
	edit: [{ p: 'M4 20h4L19 9a2.8 2.8 0 0 0-4-4L4 16z' }, { p: 'm13.5 6.5 4 4' }],
	list: [{ p: 'M9 6h11M9 12h11M9 18h11M4.5 6h.01M4.5 12h.01M4.5 18h.01' }],
	'check-circle': [{ c: [12, 12, 9] }, { p: 'm8 12.5 3 3 5-6' }],
	clock: [{ c: [12, 12, 8.5] }, { p: 'M12 7.5V12l3 2' }],
	more: { fill: true, shapes: [{ c: [5.5, 12, 1.6] }, { c: [12, 12, 1.6] }, { c: [18.5, 12, 1.6] }] },
	stop: { fill: true, shapes: [{ r: [6.5, 6.5, 11, 11, 2.5] }] }
} satisfies Record<string, IconShape[] | FilledIcon>;

export type IconName = keyof typeof ICONS;

/** The shapes of an icon and whether they are filled. */
export function iconShapes(name: IconName): { fill: boolean; shapes: IconShape[] } {
	const icon: IconShape[] | FilledIcon = ICONS[name];
	return Array.isArray(icon) ? { fill: false, shapes: icon } : { fill: true, shapes: icon.shapes };
}
