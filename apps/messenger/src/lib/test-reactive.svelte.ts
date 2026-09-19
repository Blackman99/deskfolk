/** A `$state` copy of a plain object, so a bound or watched prop actually re-renders the pane. */
export function reactive<T extends object>(value: T): T {
	const box = $state(value);
	return box;
}
