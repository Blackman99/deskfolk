type Size = { width: number; height: number };

/**
 * The zoom, in percent of the slide's own size, that fits the whole slide in the frame: the
 * narrower of the two sides decides. Null until both have a size — a frame still hidden has none.
 */
export function slideZoom(frame: Size, slide: Size): number | null {
	if (!(frame.width > 0 && frame.height > 0 && slide.width > 0 && slide.height > 0)) return null;
	return Math.min(frame.width / slide.width, frame.height / slide.height) * 100;
}

const STEPS: Record<string, number> = {
	ArrowRight: 1, ArrowDown: 1, PageDown: 1,
	ArrowLeft: -1, ArrowUp: -1, PageUp: -1
};

/**
 * The slide a key turns to, the way a slide show does, or null for a key it leaves alone.
 * The ends stay where they are rather than wrapping round.
 */
export function slideForKey(key: string, index: number, count: number): number | null {
	if (count <= 0) return null;
	const last = count - 1;
	if (key === 'Home') return 0;
	if (key === 'End') return last;
	const step = STEPS[key];
	return step === undefined ? null : Math.min(last, Math.max(0, index + step));
}
