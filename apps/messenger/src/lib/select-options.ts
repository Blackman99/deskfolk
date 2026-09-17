export interface SelectOption {
	value: string;
	label?: string;
	disabled?: boolean;
	hint?: string;
}

export interface NormalizedSelectOption {
	value: string;
	label: string;
	disabled: boolean;
	hint?: string;
}

/**
 * Normalizes an array of options (strings or objects) into a uniform list of option items.
 * If emptyLabel is provided, an empty value option is prepended if not already present.
 */
export function normalizeOptions(
	options: readonly (SelectOption | string)[],
	emptyLabel?: string
): NormalizedSelectOption[] {
	const result: NormalizedSelectOption[] = [];

	if (emptyLabel !== undefined && emptyLabel !== null && emptyLabel !== '') {
		result.push({
			value: '',
			label: emptyLabel,
			disabled: false
		});
	}

	for (const item of options) {
		if (typeof item === 'string') {
			result.push({
				value: item,
				label: item,
				disabled: false
			});
		} else if (item && typeof item === 'object') {
			// If emptyLabel was provided and this item is also empty, replace or skip duplicate
			if (emptyLabel && item.value === '') {
				continue;
			}
			result.push({
				value: item.value ?? '',
				label: item.label ?? item.value ?? '',
				disabled: Boolean(item.disabled),
				hint: item.hint
			});
		}
	}

	return result;
}

/**
 * Finds the next enabled option index in the specified direction (1 for down, -1 for up),
 * wrapping around the list.
 */
export function findNextEnabledIndex(
	options: readonly NormalizedSelectOption[],
	currentIndex: number,
	direction: 1 | -1
): number {
	if (options.length === 0) return -1;
	const len = options.length;
	let idx = currentIndex < 0 ? (direction === 1 ? -1 : 0) : currentIndex;

	for (let step = 0; step < len; step++) {
		idx = (idx + direction + len) % len;
		if (!options[idx].disabled) {
			return idx;
		}
	}

	return currentIndex >= 0 && currentIndex < len && !options[currentIndex].disabled
		? currentIndex
		: -1;
}

/**
 * Finds the first enabled option whose label starts with the given prefix.
 */
export function findOptionByPrefix(
	options: readonly NormalizedSelectOption[],
	prefix: string
): number {
	const lower = prefix.trim().toLowerCase();
	if (!lower) return -1;
	return options.findIndex(
		(opt) => !opt.disabled && opt.label.toLowerCase().startsWith(lower)
	);
}
