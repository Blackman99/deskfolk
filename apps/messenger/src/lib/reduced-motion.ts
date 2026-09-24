/**
 * Whether the system asks for less motion, so a glide or slide goes straight to where it ends.
 * Where there is nothing to ask (no `matchMedia`), it does not.
 */
export function prefersReducedMotion(): boolean {
	return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
}
