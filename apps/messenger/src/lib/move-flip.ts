import { flip, type AnimationConfig, type FlipParams } from 'svelte/animate';

/**
 * `flip` for a row that moves, not one that changes size. Svelte's `flip` runs whenever a row's box
 * changed at all and starts it at its old size, so a row that only got narrower or wider squeezes
 * or stretches back into place. In a list that happens to every row at once when a row added or
 * removed brings the list's scrollbar in or takes it away (a classic scrollbar is 15px). Here the
 * row starts at its old top-left corner at its new size: a row that moved slides, one that did not
 * stays still.
 */
export function moveFlip(node: Element, { from, to }: { from: DOMRect; to: DOMRect }, params?: FlipParams): AnimationConfig {
	if (from.left === to.left && from.top === to.top) return { duration: 0 };
	return flip(node, { from: new DOMRect(from.left, from.top, to.width, to.height), to }, params);
}
