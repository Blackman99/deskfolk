/**
 * Short confirmations at the bottom of the window: "Copied", "Saved to …", "Not sent — Retry".
 *
 * For an action whose result is not otherwise on screen — a copy from a menu that has already
 * closed, a save that lands in a file. Something already shown in place (the ✓ on a copy button
 * the pointer is on) does not need one too.
 *
 * One at a time: a new toast replaces the one showing, so a quick run of copies reads as one
 * steady confirmation rather than a stack.
 */
export type ToastTone = 'neutral' | 'error';

export type ToastAction = { label: string; run: () => void };

export type Toast = {
	id: number;
	text: string;
	tone: ToastTone;
	action: ToastAction | null;
	/** Set while it plays its way out, so the host can animate the leaving one. */
	leaving: boolean;
};

/** How long a plain toast stays; one with an action waits longer, to give time to reach it. */
export const TOAST_MS = 2000;
export const TOAST_ACTION_MS = 5000;
/** The leaving animation's length; matches `--dur-base`. */
export const TOAST_LEAVE_MS = 180;

class ToastStore {
	current = $state<Toast | null>(null);
	#next = 1;
	#timer: ReturnType<typeof setTimeout> | null = null;
	#leaveTimer: ReturnType<typeof setTimeout> | null = null;

	show(text: string, options: { tone?: ToastTone; action?: ToastAction; ms?: number } = {}): void {
		this.#clearTimers();
		const action = options.action ?? null;
		this.current = { id: this.#next++, text, tone: options.tone ?? 'neutral', action, leaving: false };
		this.#schedule(options.ms ?? (action ? TOAST_ACTION_MS : TOAST_MS));
	}

	/** Keeps the toast up while the pointer is on it. */
	hold(): void {
		if (this.current && !this.current.leaving) this.#clearTimers();
	}

	/** Lets a held toast go again, after a short while. */
	release(): void {
		if (this.current && !this.current.leaving) this.#schedule(TOAST_MS);
	}

	dismiss(): void {
		const toast = this.current;
		if (!toast || toast.leaving) return;
		this.#clearTimers();
		this.current = { ...toast, leaving: true };
		this.#leaveTimer = setTimeout(() => {
			if (this.current?.id === toast.id) this.current = null;
		}, TOAST_LEAVE_MS);
	}

	#schedule(ms: number): void {
		this.#clearTimers();
		this.#timer = setTimeout(() => this.dismiss(), ms);
	}

	#clearTimers(): void {
		if (this.#timer) clearTimeout(this.#timer);
		if (this.#leaveTimer) clearTimeout(this.#leaveTimer);
		this.#timer = null;
		this.#leaveTimer = null;
	}
}

export const toasts = new ToastStore();

export function showToast(text: string, options?: { tone?: ToastTone; action?: ToastAction; ms?: number }): void {
	toasts.show(text, options);
}
