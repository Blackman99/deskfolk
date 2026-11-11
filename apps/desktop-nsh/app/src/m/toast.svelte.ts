// Ported from apps/messenger/src/lib by scripts/port-messenger.ts; edited here since.
// Source: e79c40a10e62d444
import { state } from "../lib/reactive";
/**
 * Short notices in the top-right corner: "Copied", "Saved to …", "Not sent — Retry".
 *
 * For an action whose result is not otherwise on screen — a copy from a menu that has already
 * closed, a save that lands in a file. Something already shown in place (the ✓ on a copy button
 * the pointer is on) does not need one too.
 *
 * One at a time: a new toast replaces the one showing, so a quick run of copies reads as one
 * steady confirmation rather than a stack. Each one shows how long it has left and can be closed
 * by hand; a pointer on it, or keyboard focus in it, stops the countdown where it is.
 */
export type ToastTone = 'neutral' | 'info' | 'error';

export type ToastAction = { label: string; run: () => void };

export type Toast = {
	id: number;
	text: string;
	/** `neutral` confirms something done (✓), `info` explains why nothing happened, `error` a failure. */
	tone: ToastTone;
	action: ToastAction | null;
	/** Its whole countdown, from when it appears; the host draws the time left over this span. */
	ms: number;
	/** Held by the pointer or by keyboard focus: the countdown stands still. */
	paused: boolean;
	/** Set while it plays its way out, so the host can animate the leaving one. */
	leaving: boolean;
};

/** Why a toast is held; it runs again only once nothing holds it. */
export type ToastHold = 'pointer' | 'focus';

/** How long a plain toast stays; one with an action waits longer, to give time to reach it. */
export const TOAST_MS = 4000;
export const TOAST_ACTION_MS = 6000;
/** The leaving animation's length; matches `--dur-base`. */
export const TOAST_LEAVE_MS = 180;

class ToastStore {
	#current$s = state<Toast | null>(null);
	get current(): Toast | null { return this.#current$s.get(); }
	set current(value: Toast | null) { this.#current$s.set(value); }
	#next = 1;
	#timer: ReturnType<typeof setTimeout> | null = null;
	#leaveTimer: ReturnType<typeof setTimeout> | null = null;
	/** Countdown left as of `#runningSince`, which is null while held. */
	#left = 0;
	#runningSince: number | null = null;
	#holds = new Set<ToastHold>();

	show(text: string, options: { tone?: ToastTone; action?: ToastAction; ms?: number } = {}): void {
		this.#clearTimers();
		this.#holds.clear();
		const action = options.action ?? null;
		const ms = options.ms ?? (action ? TOAST_ACTION_MS : TOAST_MS);
		this.current = { id: this.#next++, text, tone: options.tone ?? 'neutral', action, ms, paused: false, leaving: false };
		this.#left = ms;
		this.#run();
	}

	/** Stops the countdown where it is, for as long as anything holds it. */
	hold(by: ToastHold): void {
		const toast = this.current;
		if (!toast || toast.leaving) return;
		this.#holds.add(by);
		if (toast.paused) return;
		this.#left = this.remaining();
		this.#runningSince = null;
		this.#clearTimers();
		this.current = { ...toast, paused: true };
	}

	/** Lets go of one hold; the countdown goes on from where it stopped once none is left. */
	release(by: ToastHold): void {
		const toast = this.current;
		if (!toast || toast.leaving || !this.#holds.delete(by) || this.#holds.size > 0) return;
		this.current = { ...toast, paused: false };
		this.#run();
	}

	/** Milliseconds before the one showing closes by itself. */
	remaining(): number {
		if (this.#runningSince === null) return this.#left;
		return Math.max(0, this.#left - (Date.now() - this.#runningSince));
	}

	dismiss(): void {
		const toast = this.current;
		if (!toast || toast.leaving) return;
		this.#clearTimers();
		this.#holds.clear();
		this.#runningSince = null;
		this.current = { ...toast, leaving: true };
		this.#leaveTimer = setTimeout(() => {
			if (this.current?.id === toast.id) this.current = null;
		}, TOAST_LEAVE_MS);
	}

	#run(): void {
		this.#clearTimers();
		this.#runningSince = Date.now();
		this.#timer = setTimeout(() => this.dismiss(), this.#left);
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
