/**
 * The app's icons, by name: one set, so every icon on a screen has the same weight.
 *
 * Each is drawn on a 24-unit grid with round caps and joins. `Icon.svelte` strokes them at a fixed
 * 1.6 screen pixels whatever their size (`vector-effect: non-scaling-stroke`), so a 12px chevron
 * and a 20px toolbar icon read as the same pen. Sizes come from `ICON_SIZES`, one per role.
 *
 * Every UI icon comes from here; components never paste an `<svg>` for one. What stays inline is
 * not an icon: the brand mark, the folk avatar, provider and agent logos, progress rings and
 * drawn diagrams.
 *
 * `FILLED` holds the solid twin of an icon, for a state the icon itself shows (a pinned
 * conversation, the default model) and the phone's current tab. A selected item of a set is
 * marked by colour, not by a solid twin: the accent's tint behind it, the accent on its icon.
 */
export type IconShape =
	| { p: string; evenodd?: true }
	| { c: [number, number, number] }
	| { r: [number, number, number, number, number] };

/** An icon that is always drawn solid (the dots of "more", the stop square). */
export type FilledIcon = { fill: true; shapes: IconShape[] };

/**
 * The sizes an icon is drawn at, by role:
 * - 12: inside a line of text, a chip, a micro chevron or close in a dense row;
 * - 16: the default, in lists, menus, buttons and rows;
 * - 20: toolbars, the composer, pane headers, navigation;
 * - 24: the phone's tab bar and floating buttons;
 * - 32: an empty state's illustration.
 */
export const ICON_SIZES = [12, 16, 20, 24, 32] as const;
export type IconSize = (typeof ICON_SIZES)[number];

const FILE = 'M14 3H7.5A2.5 2.5 0 0 0 5 5.5v13A2.5 2.5 0 0 0 7.5 21h9a2.5 2.5 0 0 0 2.5-2.5V8z';
const FOLDER = 'M3 7.5A2.5 2.5 0 0 1 5.5 5H9l2 2h7.5A2.5 2.5 0 0 1 21 9.5v7a2.5 2.5 0 0 1-2.5 2.5h-13A2.5 2.5 0 0 1 3 16.5z';
const GEAR =
	'M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z';
const PIN_HEAD =
	'M5 17h14v-1.76a2 2 0 0 0-1.11-1.79l-1.78-.89A2 2 0 0 1 15 10.77V6a3 3 0 0 0-6 0v4.77a2 2 0 0 1-1.11 1.79l-1.78.89A2 2 0 0 0 5 15.24Z';
const BELL = 'M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9';
const BUBBLE = 'M20.5 15a2 2 0 0 1-2 2H7.5l-4 4V5.5a2 2 0 0 1 2-2h13a2 2 0 0 1 2 2z';
const STAR = 'M12 2.8l2.85 5.8 6.4.93-4.63 4.5 1.1 6.37L12 17.4l-5.72 3l1.1-6.37-4.63-4.5 6.4-.93z';
const SHIELD = 'M12 21.5s7.5-3.6 7.5-9.5V5.5L12 2.5l-7.5 3V12c0 5.9 7.5 9.5 7.5 9.5z';
const BOX = 'M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z';
const PANE = [3.5, 4.5, 17, 15, 2] as [number, number, number, number, number];

export const ICONS = {
	// Marks and arrows
	x: [{ p: 'M6 6l12 12M18 6 6 18' }],
	plus: [{ p: 'M12 5v14M5 12h14' }],
	minus: [{ p: 'M5 12h14' }],
	check: [{ p: 'm5 12.5 4.5 4.5L19 7.5' }],
	'chevron-down': [{ p: 'm6 9 6 6 6-6' }],
	'chevron-up': [{ p: 'm18 15-6-6-6 6' }],
	'chevron-right': [{ p: 'm9 6 6 6-6 6' }],
	'chevron-left': [{ p: 'm15 6-6 6 6 6' }],
	'arrow-up': [{ p: 'M12 19V5M6 11l6-6 6 6' }],
	'arrow-down': [{ p: 'M12 5v14M6 13l6 6 6-6' }],
	'arrow-right': [{ p: 'M5 12h14M13 6l6 6-6 6' }],
	'arrow-left': [{ p: 'M19 12H5M11 6l-6 6 6 6' }],
	'arrow-up-right': [{ p: 'M7 17 17 7M8 7h9v9' }],
	'corner-down-left': [{ p: 'm9 10-5 5 5 5' }, { p: 'M20 4v7a4 4 0 0 1-4 4H4' }],
	reply: [{ p: 'M9 15 4 10l5-5' }, { p: 'M4 10h10a6 6 0 0 1 6 6v3' }],
	external: [{ p: 'M14 4h6v6M20 4l-9 9' }, { p: 'M18 14v4.5a2.5 2.5 0 0 1-2.5 2.5h-10A2.5 2.5 0 0 1 3 18.5v-10A2.5 2.5 0 0 1 5.5 6H10' }],
	download: [{ p: 'M12 4v11M7 10l5 5 5-5M5 20h14' }],
	upload: [{ p: 'M12 15V4M7 9l5-5 5 5M5 20h14' }],
	send: [{ p: 'M21.5 2.5 11 13' }, { p: 'm21.5 2.5-6.5 19-4-8.5-8.5-4z' }],
	refresh: [{ p: 'M21 12a9 9 0 1 1-6.2-8.6' }, { p: 'M21 4v5h-5' }],
	'rotate-ccw': [{ p: 'M3 12a9 9 0 1 0 2.6-6.4L3 8' }, { p: 'M3 3v5h5' }],
	repeat: [{ p: 'm17 2 4 4-4 4' }, { p: 'M3 11v-1a4 4 0 0 1 4-4h14' }, { p: 'm7 22-4-4 4-4' }, { p: 'M21 13v1a4 4 0 0 1-4 4H3' }],
	maximize: [{ p: 'M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5' }],
	minimize: [{ p: 'M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5' }],

	// States
	'check-circle': [{ c: [12, 12, 9] }, { p: 'm8 12.5 3 3 5-6' }],
	'check-square': [{ p: 'm9 11 3 3 9-9' }, { p: 'M20 12v6.5a2.5 2.5 0 0 1-2.5 2.5h-11A2.5 2.5 0 0 1 4 18.5v-11A2.5 2.5 0 0 1 6.5 5H15' }],
	'alert-circle': [{ c: [12, 12, 9] }, { p: 'M12 8v5M12 16.5h.01' }],
	'alert-triangle': [{ p: 'M10.3 4.2 2.6 17.5a2 2 0 0 0 1.7 3h15.4a2 2 0 0 0 1.7-3L13.7 4.2a2 2 0 0 0-3.4 0z' }, { p: 'M12 9.5v4M12 17h.01' }],
	info: [{ c: [12, 12, 9] }, { p: 'M12 16v-4.5M12 8h.01' }],
	'help-circle': [{ c: [12, 12, 9] }, { p: 'M9.5 9.5a2.6 2.6 0 0 1 5 1c0 1.7-2.5 2.2-2.5 3.8M12 17.5h.01' }],
	ban: [{ c: [12, 12, 9] }, { p: 'm5.6 5.6 12.8 12.8' }],
	'pause-circle': [{ c: [12, 12, 9] }, { p: 'M10 15V9M14 15V9' }],
	clock: [{ c: [12, 12, 8.5] }, { p: 'M12 7.5V12l3 2' }],
	history: [{ p: 'M3 12a9 9 0 1 0 2.6-6.4L3 8' }, { p: 'M3 3v5h5' }, { p: 'M12 7.5V12l3 2' }],
	spinner: [{ p: 'M21 12a9 9 0 1 1-6.2-8.6' }],
	target: [{ c: [12, 12, 9] }, { c: [12, 12, 5] }, { c: [12, 12, 1.5] }],
	eye: [{ p: 'M2.5 12S6 5 12 5s9.5 7 9.5 7-3.5 7-9.5 7-9.5-7-9.5-7z' }, { c: [12, 12, 3] }],
	lock: [{ r: [4.5, 11, 15, 10, 2.5] }, { p: 'M8 11V7.5a4 4 0 0 1 8 0V11' }],
	shield: [{ p: SHIELD }],
	'shield-check': [{ p: SHIELD }, { p: 'm9 12 2 2 4-4' }],
	sun: [{ c: [12, 12, 4] }, { p: 'M12 2.5v2M12 19.5v2M4.6 4.6 6 6M18 18l1.4 1.4M2.5 12h2M19.5 12h2M4.6 19.4 6 18M18 6l1.4-1.4' }],
	moon: [{ p: 'M20.5 13.5A8.5 8.5 0 1 1 10.5 3.5a6.5 6.5 0 0 0 10 10z' }],

	// Actions
	search: [{ c: [11, 11, 7] }, { p: 'm20 20-3.5-3.5' }],
	edit: [{ p: 'M4 20h4L19 9a2.8 2.8 0 0 0-4-4L4 16z' }, { p: 'm13.5 6.5 4 4' }],
	copy: [{ r: [9, 9, 11, 11, 2.5] }, { p: 'M15 9V6.5A2.5 2.5 0 0 0 12.5 4h-6A2.5 2.5 0 0 0 4 6.5v6A2.5 2.5 0 0 0 6.5 15H9' }],
	clipboard: [{ r: [8, 2.5, 8, 4, 1] }, { p: 'M16 4.5h1.5A2.5 2.5 0 0 1 20 7v12.5a2.5 2.5 0 0 1-2.5 2.5h-11A2.5 2.5 0 0 1 4 19.5V7a2.5 2.5 0 0 1 2.5-2.5H8' }],
	trash: [{ p: 'M4 6.5h16' }, { p: 'M9 6.5v-2A1.5 1.5 0 0 1 10.5 3h3A1.5 1.5 0 0 1 15 4.5v2' }, { p: 'm18 6.5-.8 12.6a2 2 0 0 1-2 1.9H8.8a2 2 0 0 1-2-1.9L6 6.5' }],
	archive: [{ r: [3, 4, 18, 5, 1.5] }, { p: 'M5 9v8.5A2.5 2.5 0 0 0 7.5 20h9a2.5 2.5 0 0 0 2.5-2.5V9M10 13h4' }],
	pin: [{ p: 'M12 17v5' }, { p: PIN_HEAD }],
	link: [{ p: 'M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7' }, { p: 'M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7' }],
	'smile-plus': [{ c: [11, 13, 8] }, { p: 'M8 15s1.2 1.5 3 1.5 3-1.5 3-1.5M8.5 10.5h.01M13.5 10.5h.01' }, { p: 'M19 2v5M16.5 4.5h5' }],
	funnel: [{ p: 'M3.5 4.5h17l-6.5 8v6l-4 2v-8z' }],
	filter: [{ p: 'M4 6h16M7 12h10M10 18h4' }],
	sliders: [{ p: 'M4 7h9M17 7h3M4 17h3M11 17h9' }, { c: [15, 7, 2] }, { c: [9, 17, 2] }],
	'text-cursor': [{ p: 'M17 21h-1a4 4 0 0 1-4-4V7a4 4 0 0 1 4-4h1' }, { p: 'M7 21h1a4 4 0 0 0 4-4v-1' }, { p: 'M7 3h1a4 4 0 0 1 4 4v1' }],
	type: [{ p: 'M4 7V4h16v3' }, { p: 'M9 20h6M12 4v16' }],
	hash: [{ p: 'M4 9h16M4 15h16M10 3 8 21M16 3l-2 18' }],
	lines: [{ p: 'M4 6h16M4 12h10M4 18h13' }],
	list: [{ p: 'M9 6h11M9 12h11M9 18h11M4.5 6h.01M4.5 12h.01M4.5 18h.01' }],
	fit: [{ p: 'M3 7.5V5.5A2.5 2.5 0 0 1 5.5 3h2M16.5 3h2A2.5 2.5 0 0 1 21 5.5v2M21 16.5v2a2.5 2.5 0 0 1-2.5 2.5h-2M7.5 21h-2A2.5 2.5 0 0 1 3 18.5v-2' }, { r: [7, 8, 10, 8, 1.5] }],
	play: { fill: true, shapes: [{ p: 'M7 4.8v14.4a1 1 0 0 0 1.5.86l12-7.2a1 1 0 0 0 0-1.72l-12-7.2A1 1 0 0 0 7 4.8z' }] },
	pause: { fill: true, shapes: [{ r: [6, 5, 4, 14, 1] }, { r: [14, 5, 4, 14, 1] }] },
	stop: { fill: true, shapes: [{ r: [6.5, 6.5, 11, 11, 2.5] }] },
	square: [{ r: [6, 6, 12, 12, 2] }],
	more: { fill: true, shapes: [{ c: [5.5, 12, 1.6] }, { c: [12, 12, 1.6] }, { c: [18.5, 12, 1.6] }] },
	grip: { fill: true, shapes: [{ c: [9, 6, 1.5] }, { c: [15, 6, 1.5] }, { c: [9, 12, 1.5] }, { c: [15, 12, 1.5] }, { c: [9, 18, 1.5] }, { c: [15, 18, 1.5] }] },

	// Things
	file: [{ p: FILE }, { p: 'M14 3v5h5' }],
	'file-text': [{ p: FILE }, { p: 'M14 3v5h5' }, { p: 'M8.5 13h7M8.5 17h4.5' }],
	'file-down': [{ p: FILE }, { p: 'M14 3v5h5' }, { p: 'M12 11.5v6M9 14.5l3 3 3-3' }],
	folder: [{ p: FOLDER }],
	image: [{ r: [3, 3, 18, 18, 2.5] }, { c: [9, 9, 2] }, { p: 'm21 15-3.1-3.1a2 2 0 0 0-2.8 0L6 21' }],
	music: [{ p: 'M9 18V5l12-2v13' }, { c: [6, 18, 3] }, { c: [18, 16, 3] }],
	video: [{ r: [2.5, 6, 13.5, 12, 2.5] }, { p: 'm16 10.5 5.5-3v9l-5.5-3z' }],
	code: [{ p: 'm16 18 6-6-6-6' }, { p: 'm8 6-6 6 6 6' }],
	markdown: [{ r: [2.5, 5, 19, 14, 2.5] }, { p: 'M6.5 15V9l2.5 3 2.5-3v6M17 9v6M15 13l2 2 2-2' }],
	book: [{ p: 'M4 19.5A2.5 2.5 0 0 1 6.5 17H20' }, { p: 'M6.5 2.5H20v19H6.5A2.5 2.5 0 0 1 4 19V5a2.5 2.5 0 0 1 2.5-2.5z' }],
	'book-open': [{ p: 'M2.5 4.5h6A3.5 3.5 0 0 1 12 8v12a2.5 2.5 0 0 0-2.5-2.5h-7z' }, { p: 'M21.5 4.5h-6A3.5 3.5 0 0 0 12 8v12a2.5 2.5 0 0 1 2.5-2.5h7z' }],
	message: [{ p: BUBBLE }],
	'message-lines': [{ p: BUBBLE }, { p: 'M8 8.5h8M8 12h5' }],
	bell: [{ p: BELL }, { p: 'M10.3 21a1.94 1.94 0 0 0 3.4 0' }],
	calendar: [{ r: [3.5, 5, 17, 16, 2.5] }, { p: 'M3.5 10h17M8 3v4M16 3v4' }],
	'calendar-check': [{ r: [3.5, 5, 17, 16, 2.5] }, { p: 'M3.5 10h17M8 3v4M16 3v4' }, { p: 'm9 15.5 2 2 4-4' }],
	tag: [{ p: 'M20.6 13.4l-7.2 7.2a2 2 0 0 1-2.8 0L3 13V3h10l7.6 7.6a2 2 0 0 1 0 2.8z' }, { c: [7.5, 7.5, 1.5] }],
	star: [{ p: STAR }],
	zap: [{ p: 'M13 2 3 14h9l-1 8 10-12h-9l1-8z' }],
	sparkle: [{ p: 'M12 3.5 13.7 9 19 10.5 13.7 12 12 17.5 10.3 12 5 10.5 10.3 9z' }],
	sparkles: [
		{ p: 'M9.9 15.5a2 2 0 0 0-1.4-1.4l-6.1-1.6a.5.5 0 0 1 0-1l6.1-1.6a2 2 0 0 0 1.4-1.4l1.6-6.1a.5.5 0 0 1 1 0l1.6 6.1a2 2 0 0 0 1.4 1.4l6.1 1.6a.5.5 0 0 1 0 1l-6.1 1.6a2 2 0 0 0-1.4 1.4l-1.6 6.1a.5.5 0 0 1-1 0z' },
		{ p: 'M20 3v4M22 5h-4' }
	],
	wrench: [{ p: 'M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.8-3.8a6 6 0 0 1-7.9 7.9l-6.9 6.9a2.1 2.1 0 0 1-3-3l6.9-6.9a6 6 0 0 1 7.9-7.9z' }],
	settings: [{ p: GEAR }, { c: [12, 12, 3] }],
	plug: [{ p: 'M12 22v-5M9 8V2M15 8V2' }, { p: 'M18 8v5a4 4 0 0 1-4 4h-4a4 4 0 0 1-4-4V8z' }],
	mic: [{ r: [9, 2.5, 6, 11.5, 3] }, { p: 'M19 10v1a7 7 0 0 1-14 0v-1M12 18v3.5' }],
	paperclip: [{ p: 'm21.4 11.05-9.2 9.2a6 6 0 0 1-8.5-8.5l8.6-8.6a4 4 0 1 1 5.7 5.7l-8.6 8.6a2 2 0 0 1-2.8-2.8l8.5-8.5' }],
	globe: [{ c: [12, 12, 9] }, { p: 'M3 12h18' }, { p: 'M12 3a14 14 0 0 1 0 18 14 14 0 0 1 0-18z' }],
	dollar: [{ p: 'M12 2v20' }, { p: 'M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6' }],
	coins: [{ c: [8, 8, 6] }, { p: 'M18.1 10.4A6 6 0 1 1 10.3 18' }, { p: 'm7 6 2 4' }],
	gauge: [{ p: 'm12 14 4-4' }, { p: 'M3.3 19a10 10 0 1 1 17.4 0' }],
	activity: [{ p: 'M22 12h-4l-3 9L9 3l-3 9H2' }],
	box: [{ p: BOX }, { p: 'm3.3 7 8.7 5 8.7-5M12 22V12' }],
	package: [{ p: BOX }, { p: 'm3.3 7 8.7 5 8.7-5M12 22V12' }, { p: 'm7.5 4.3 9 5.1' }],
	layers: [{ p: 'M3 7.5 12 3l9 4.5-9 4.5z' }, { p: 'm3 12 9 4.5 9-4.5' }, { p: 'm3 16.5 9 4.5 9-4.5' }],
	server: [{ r: [3, 3.5, 18, 7, 2] }, { r: [3, 13.5, 18, 7, 2] }, { p: 'M7 7h.01M7 17h.01' }],
	monitor: [{ r: [2.5, 3.5, 19, 13, 2] }, { p: 'M8 21h8M12 16.5V21' }],
	tablet: [{ r: [5, 2.5, 14, 19, 2.5] }, { p: 'M11 18h2' }],
	smartphone: [{ r: [7, 2.5, 10, 19, 2.5] }, { p: 'M11 5.5h2' }],
	keyboard: [{ r: [2.5, 4.5, 19, 12, 2] }, { p: 'M6.5 8.5h.01M10 8.5h.01M14 8.5h.01M17.5 8.5h.01M7.5 12.5h9' }],
	'keyboard-show': [{ r: [2.5, 3, 19, 12, 2] }, { p: 'M6.5 7h.01M10 7h.01M14 7h.01M17.5 7h.01M7.5 11h9' }, { p: 'm9 21 3-3 3 3' }],
	'keyboard-hide': [{ r: [2.5, 3, 19, 12, 2] }, { p: 'M6.5 7h.01M10 7h.01M14 7h.01M17.5 7h.01M7.5 11h9' }, { p: 'm9 18 3 3 3-3' }],
	pointer: [{ p: 'M5.5 3.5v15l4-3.8 2.7 6.2 2.6-1.1-2.7-6.1h6.1z' }],
	terminal: [{ p: 'm5 8 4 4-4 4M12 16h7' }],
	'terminal-square': [{ r: [3, 3, 18, 18, 2.5] }, { p: 'm7.5 9.5 2.5 2.5-2.5 2.5M12.5 14.5h4' }],
	bot: [{ r: [4, 8, 16, 12, 3] }, { p: 'M12 8V4' }, { c: [9, 14, 1] }, { c: [15, 14, 1] }],
	user: [{ c: [12, 7.5, 4] }, { p: 'M4.5 21a7.5 7.5 0 0 1 15 0' }],
	'user-plus': [{ c: [10, 8, 4] }, { p: 'M3 20a7 7 0 0 1 14 0M19 8v6M16 11h6' }],
	users: [{ c: [9, 8, 3.5] }, { p: 'M3 20a6 6 0 0 1 12 0' }, { c: [17, 9, 2.5] }, { p: 'M16 14.2a5 5 0 0 1 5 4.8' }],

	// Structure: panes, plans and flows
	flow: [{ c: [6, 6, 2.2] }, { c: [6, 18, 2.2] }, { c: [18, 12, 2.2] }, { p: 'M6 8.2v7.6M8.2 6h1.8a6 6 0 0 1 6 4M8.2 18h1.8a6 6 0 0 0 6-4' }],
	hierarchy: [{ r: [8, 2.5, 8, 6, 1.5] }, { p: 'M12 8.5v3M5.5 14v-2.5h13V14' }, { r: [2, 14, 7, 6, 1.5] }, { r: [15, 14, 7, 6, 1.5] }],
	nodes: [{ c: [5, 6, 2] }, { c: [19, 6, 2] }, { c: [12, 18, 2] }, { p: 'M7 6h10M6 8l5 8M18 8l-5 8' }],
	'git-branch': [{ p: 'M6 3v12' }, { c: [18, 6, 3] }, { c: [6, 18, 3] }, { p: 'M18 9a9 9 0 0 1-9 9' }],
	'trace-step': [{ c: [12, 5, 2] }, { c: [12, 19, 2] }, { p: 'M12 7v10M12 12h3' }, { r: [15, 10, 6, 4, 1] }],
	kanban: [{ r: [3, 3, 5, 18, 1] }, { r: [10, 3, 5, 12, 1] }, { r: [17, 3, 4, 8, 1] }],
	grid: [{ r: [3.5, 3.5, 7, 7, 1.5] }, { r: [13.5, 3.5, 7, 7, 1.5] }, { r: [3.5, 13.5, 7, 7, 1.5] }, { r: [13.5, 13.5, 7, 7, 1.5] }],
	layout: [{ r: [3, 4, 18, 16, 2.5] }, { p: 'M12 4v16M12 12h9' }],
	minimap: [{ r: [3, 3, 18, 18, 2.5] }, { r: [12, 12, 6, 6, 1] }],
	'sidebar-open': [{ r: [3, 3, 18, 18, 2.5] }, { p: 'M9 3v18' }, { p: 'm14 9 3 3-3 3' }],
	'sidebar-close': [{ r: [3, 3, 18, 18, 2.5] }, { p: 'M9 3v18' }, { p: 'm16 15-3-3 3-3' }],
	'panel-arrow-down': [{ r: PANE }, { p: 'M12 8v6m-3-3 3 3 3-3' }],
	'panel-inset': [{ r: PANE }, { r: [8, 8, 10, 8, 1.5] }],
	'split-up': [{ r: PANE }, { p: 'M5 6h14v5.5H5z' }],
	'split-down': [{ r: PANE }, { p: 'M5 12.5h14V18H5z' }],
	'split-left': [{ p: 'M5 6h6.25v12H5z' }, { r: PANE }],
	'split-right': [{ r: PANE }, { p: 'M12.75 6H19v12h-6.25z' }]
} satisfies Record<string, IconShape[] | FilledIcon>;

export type IconName = keyof typeof ICONS;

/**
 * The solid twin of an icon, for a state it shows (see above). Shapes are filled and stroked with
 * the same pen, so the solid one keeps the outline's silhouette; an `evenodd` shape cuts a hole.
 */
export const FILLED: Partial<Record<IconName, IconShape[]>> = {
	folder: [{ p: FOLDER }],
	file: [{ p: `${FILE}M14 3v5h5` }],
	grid: ICONS.grid,
	settings: [{ p: `${GEAR}M15 12a3 3 0 1 0-6 0 3 3 0 0 0 6 0z`, evenodd: true }],
	pin: [{ p: 'M12 17v5' }, { p: PIN_HEAD }],
	bell: [{ p: `${BELL}z` }, { p: 'M10.3 21a1.94 1.94 0 0 0 3.4 0' }],
	message: [{ p: BUBBLE }],
	star: [{ p: STAR }],
	user: [{ c: [12, 7.5, 4] }, { p: 'M4.5 21a7.5 7.5 0 0 1 15 0z' }],
	bot: [{ p: 'M7 8h10a3 3 0 0 1 3 3v6a3 3 0 0 1-3 3H7a3 3 0 0 1-3-3v-6a3 3 0 0 1 3-3zM10 14a1 1 0 1 0-2 0 1 1 0 0 0 2 0zM16 14a1 1 0 1 0-2 0 1 1 0 0 0 2 0z', evenodd: true }, { p: 'M12 8V4' }],
	calendar: [{ p: 'M6 5h12a2.5 2.5 0 0 1 2.5 2.5V10h-17V7.5A2.5 2.5 0 0 1 6 5z' }, { r: [3.5, 5, 17, 16, 2.5] }, { p: 'M8 3v4M16 3v4' }],
	shield: [{ p: SHIELD }],
	box: [{ p: BOX }]
};

/** The shapes of an icon, whether they are filled, and whether this is the solid twin. */
export function iconShapes(name: IconName, filled = false): { fill: boolean; solid: boolean; shapes: IconShape[] } {
	const twin = filled ? FILLED[name] : undefined;
	if (twin) return { fill: false, solid: true, shapes: twin };
	const icon: IconShape[] | FilledIcon = ICONS[name];
	return Array.isArray(icon) ? { fill: false, solid: false, shapes: icon } : { fill: true, solid: false, shapes: icon.shapes };
}
