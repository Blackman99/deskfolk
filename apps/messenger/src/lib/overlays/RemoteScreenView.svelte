<script lang="ts" module>
	import type { ScreenChannel } from '../remote/rfb-channel.ts';

	/** The part of noVNC's `RFB` this page drives. */
	export interface Rfb extends EventTarget {
		scaleViewport: boolean;
		clipViewport: boolean;
		dragViewport: boolean;
		resizeSession: boolean;
		focusOnClick: boolean;
		background: string;
		sendCredentials(credentials: { username?: string; password?: string }): void;
		sendKey(keysym: number, code: string | null, down?: boolean): void;
		disconnect(): void;
	}
	export type RfbConstructor = new (
		target: HTMLElement,
		channel: ScreenChannel,
		options?: { credentials?: { username?: string; password?: string }; shared?: boolean }
	) => Rfb;
</script>

<script lang="ts">
	import { onMount } from 'svelte';
	import type { Copy } from '../copy.ts';
	import { ApiError } from '../api.ts';
	import { connectScreen, type ScreenApi, type ScreenConnection, type SmoothResult } from '../remote/screen-connect.ts';
	import { KEYSYM, MODIFIERS, SCREEN_KEYS, press, typeText, type Modifier } from './remote-screen-keys.ts';
	import { loadNoVnc } from './novnc-loader.ts';
	import { actualZoom, boxFor, follow, keepShown, maxZoom, panBy, zoomAround, type Point, type Size, type ZoomView } from './screen-zoom.ts';
	import { TrackpadGestures, loadTrackpadMode, pointerGain, saveTrackpadMode, type Finger, type TrackpadAction } from './screen-trackpad.ts';
	import { loadScreenFlag, saveScreenFlag } from './screen-prefs.ts';
	import { BUTTON, PointerOut } from './screen-pointer.ts';
	import type { RememberedSignIn } from '../remote/screen-sign-in.ts';

	/**
	 * The Mac's own screen, on the paired device: macOS Screen Sharing, drawn by noVNC, reached straight
	 * or through the relay (see screen-connect.ts). Taps are clicks where the finger lands, two
	 * fingers are a right click or a scroll; in trackpad mode the glass moves a pointer instead (see
	 * screen-trackpad.ts). Smooth mode asks the Mac to lower its resolution while connected, so a
	 * window switch is a third of the bytes to fetch and decode. The row at the bottom has the keys
	 * a soft keyboard lacks. The account password Screen Sharing asks for stays in this page's
	 * memory, to sign straight back in after a drop.
	 */
	interface Props {
		api: ScreenApi & {
			screenStatus(sessionId: string): Promise<{ mode: string }>;
			screenStop(sessionId: string): Promise<void>;
		};
		t: Copy;
		onClose: () => void;
		/** Tests hand in a stand-in; the page loads noVNC itself otherwise. */
		loadRfb?: () => Promise<RfbConstructor>;
		connect?: typeof connectScreen;
		/** How often the page tells the Mac it is still here. */
		keepaliveMs?: number;
		/** How long Screen Sharing gets to answer once the channel is up, before the page gives up. */
		answerMs?: number;
		/** The Mac account kept on this phone after it once got in; absent, it is asked every time. */
		remember?: RememberedSignIn;
	}

	let { api, t, onClose, loadRfb, connect = connectScreen, keepaliveMs = 15_000, answerMs = 20_000, remember }: Props = $props();

	type Phase = 'connecting' | 'signin' | 'live' | 'ended' | 'failed' | 'paused';
	let phase = $state<Phase>('connecting');
	/** Where a connection is while it is connecting, so a page that stays on it says which step. */
	type Step = 'loading' | 'linking' | 'answer';
	let step = $state<Step>('loading');
	let route = $state<ScreenConnection['mode'] | null>(null);
	let problem = $state<string | null>(null);
	let needsUsername = $state(true);
	let username = $state('');
	let password = $state('');
	/** The stage the picture is shown on, and the picture's own size once Screen Sharing announced it. */
	let stage = $state<Size>({ w: 0, h: 0 });
	let frame = $state<Size | null>(null);
	/** Zoomed on the phone, never on the Mac: noVNC's own pinch would send the Mac ⌃-scroll. */
	let view = $state<ZoomView>({ zoom: 1, pan: { x: 0, y: 0 } });
	const box = $derived(frame && stage.w && stage.h ? boxFor(stage, frame, view) : null);
	const zoomed = $derived(view.zoom > 1.01);
	/** Whether a sign-in that gets in is kept for next time. */
	let keepSignIn = $state(true);
	/** Picture bytes arriving, while they do: a big first frame is a wait, not a broken screen. */
	let transfer = $state<{ total: number; rate: number } | null>(null);
	let armed = $state<Modifier[]>([]);
	let keyboardUp = $state(false);
	/** Trackpad mode: a finger moves the pointer by its travel and a tap clicks where the pointer is. */
	let trackpad = $state(loadTrackpadMode());
	/** Where the Mac's pointer is, as far as this page knows, in the Mac's pixels. */
	let pointer = $state<Point | null>(null);
	/** The left button held down by a trackpad drag. */
	let dragging = $state(false);
	/** Smooth mode: the Mac lowers its resolution while this page is connected. */
	let smooth = $state(loadScreenFlag('smooth'));
	/** What the Mac did with the last connection's smooth request, said once it is live. */
	let smoothAnswer: SmoothResult | null | undefined;
	/** A line said for a few seconds over the picture: the trackpad's gestures, smooth mode's answer. */
	let tip = $state<string | null>(null);
	/** How far the trackpad pointer keeps from a stage edge the picture runs past, in CSS pixels. */
	const POINTER_MARGIN = 40;
	/** The trackpad pointer on the stage: always somewhere the page shows (see keepShown). */
	const pointerShown = $derived.by(() => {
		if (!trackpad || !frame || !box || !stage.w || !stage.h) return null;
		const at = keepShown(stage, frame, view, pointer ?? { x: frame.w / 2, y: frame.h / 2 }, POINTER_MARGIN);
		return { x: box.left + (at.x * box.width) / frame.w, y: box.top + (at.y * box.height) / frame.h };
	});

	let screenEl = $state<HTMLDivElement | null>(null);
	let stageEl = $state<HTMLDivElement | null>(null);
	let inputEl = $state<HTMLInputElement | null>(null);

	let rfb: Rfb | null = null;
	let connection: ScreenConnection | null = null;
	const pointerOut = new PointerOut((bytes) => connection?.channel.send(bytes));
	const gestures = new TrackpadGestures((action) => onTrackpad(action));
	let pinchFrom: ZoomView | null = null;
	let tipTimer: ReturnType<typeof setTimeout> | null = null;
	let keepalive: ReturnType<typeof setInterval> | null = null;
	let answerTimer: ReturnType<typeof setTimeout> | null = null;
	let meter: ReturnType<typeof setInterval> | null = null;
	let rememberedLoaded = false;
	/** Whether this page is the one ending the connection; noVNC's disconnect then says nothing. */
	let leaving = false;
	let remembered: { username?: string; password?: string } | null = null;
	let attempt = 0;

	const SENTINEL = ' ';
	let typed = SENTINEL;

	function explain(error: unknown): string {
		const code = error instanceof ApiError ? error.code : null;
		if (code === 'screen_disabled') return t.screen.disabledOnMac;
		if (code === 'screen_sharing_off') return t.screen.sharingOff;
		return t.screen.failed;
	}

	function teardown(): void {
		if (keepalive) clearInterval(keepalive);
		keepalive = null;
		if (answerTimer) clearTimeout(answerTimer);
		answerTimer = null;
		if (meter) clearInterval(meter);
		meter = null;
		transfer = null;
		gestures.reset();
		pointerOut.reset();
		dragging = false;
		leaving = true;
		const current = rfb;
		rfb = null;
		try { current?.disconnect(); } catch {}
		const held = connection;
		connection = null;
		try { held?.channel.close(); } catch {}
		if (held) void api.screenStop(held.sessionId).catch(() => {});
	}

	async function start(): Promise<void> {
		teardown();
		leaving = false;
		const mine = ++attempt;
		phase = 'connecting';
		step = 'loading';
		problem = null;
		route = null;
		showTip(null);
		try {
			const Rfb = loadRfb
				? await loadRfb()
				: ((await loadNoVnc(() => import('@novnc/novnc'))).default as unknown as RfbConstructor);
			if (mine !== attempt) return;
			if (!rememberedLoaded && remember) {
				rememberedLoaded = true;
				remembered = await remember.load();
				if (remembered?.username) username = remembered.username;
				if (mine !== attempt) return;
			}
			step = 'linking';
			const opened = await connect(api, { smooth });
			if (mine !== attempt || !screenEl) {
				opened.channel.close();
				void api.screenStop(opened.sessionId).catch(() => {});
				if (mine === attempt) throw new Error('screen_unmounted');
				return;
			}
			connection = opened;
			route = opened.mode;
			smoothAnswer = opened.smooth;
			const client = new Rfb(screenEl, opened.channel, { shared: true, ...(remembered ? { credentials: remembered } : {}) });
			rfb = client;
			client.resizeSession = false;
			// Taps on the picture must not take the focus from the hidden field that holds the keyboard.
			client.focusOnClick = false;
			client.background = 'transparent';
			// Always fitted to its box: zoom and pan move the box (see screen-zoom.ts).
			client.scaleViewport = true;
			client.clipViewport = false;
			client.dragViewport = false;
			awaitAnswer(client);
			client.addEventListener('connect', () => {
				if (rfb !== client) return;
				clearAnswerTimer();
				phase = 'live';
				measureFrame();
				if (smoothAnswer !== undefined) showTip(smoothText(smoothAnswer));
				// In: whatever got it in is kept, unless the person said not to.
				if (remembered && keepSignIn) void remember?.save({ ...remembered, password: remembered.password ?? '' });
				watchTransfer(opened);
			});
			client.addEventListener('credentialsrequired', (event) => {
				if (rfb !== client) return;
				clearAnswerTimer();
				const types = (event as CustomEvent<{ types: string[] }>).detail?.types ?? ['password'];
				needsUsername = types.includes('username');
				phase = 'signin';
			});
			client.addEventListener('securityfailure', () => {
				if (rfb !== client) return;
				// A kept sign-in Screen Sharing no longer takes is forgotten, never retried.
				void remember?.forget();
				remembered = null;
				password = '';
				problem = t.screen.wrongPassword;
			});
			client.addEventListener('disconnect', () => {
				if (rfb !== client || leaving) return;
				const signInFailed = problem === t.screen.wrongPassword;
				// Already disconnected: asking noVNC to disconnect again would only arm its timeout.
				rfb = null;
				teardown();
				phase = signInFailed ? 'signin' : 'ended';
			});
			keepalive = setInterval(() => {
				const live = connection;
				if (!live) return;
				api.screenStatus(live.sessionId).catch((error) => {
					if (connection !== live) return;
					if (error instanceof ApiError && error.code === 'screen_session_gone') {
						teardown();
						phase = 'ended';
					}
				});
			}, keepaliveMs);
		} catch (error) {
			if (mine !== attempt) return;
			teardown();
			problem = explain(error);
			phase = 'failed';
		}
	}

	/**
	 * The channel is up and noVNC is talking; Screen Sharing should ask for a password or show the
	 * screen within seconds. One that says nothing is a dead end the page must not spin on.
	 */
	function awaitAnswer(client: Rfb): void {
		step = 'answer';
		clearAnswerTimer();
		answerTimer = setTimeout(() => {
			if (rfb !== client || phase !== 'connecting') return;
			attempt++;
			teardown();
			problem = t.screen.noAnswer;
			phase = 'failed';
		}, answerMs);
	}

	/** Samples the channel each second; shown while more than a trickle is arriving. */
	function watchTransfer(opened: ScreenConnection): void {
		if (meter) clearInterval(meter);
		let last = opened.channel.bytesIn ?? 0;
		meter = setInterval(() => {
			const total = opened.channel.bytesIn ?? 0;
			const rate = total - last;
			last = total;
			transfer = rate > 16 * 1024 ? { total, rate } : null;
		}, 1000);
	}

	function megabytes(bytes: number): string {
		return (bytes / (1024 * 1024)).toFixed(1);
	}

	function clearAnswerTimer(): void {
		if (answerTimer) clearTimeout(answerTimer);
		answerTimer = null;
	}

	/** noVNC's canvas is as big as the Mac's framebuffer. */
	function measureFrame(): void {
		const canvas = screenEl?.querySelector('canvas');
		if (!canvas || !canvas.width || !canvas.height) return;
		const next = { w: canvas.width, h: canvas.height };
		if (frame && (frame.w !== next.w || frame.h !== next.h)) {
			// A new size (smooth mode, or the Mac's own resolution changed): the pointer keeps its
			// place on the screen, and the view starts whole again.
			if (pointer) pointer = { x: (pointer.x * next.w) / frame.w, y: (pointer.y * next.h) / frame.h };
			view = { zoom: 1, pan: { x: 0, y: 0 } };
		}
		frame = next;
	}

	function measureStage(): void {
		if (stageEl) stage = { w: stageEl.clientWidth, h: stageEl.clientHeight };
	}

	function zoomLimit(): number {
		return frame ? maxZoom(stage, frame, window.devicePixelRatio || 1) : 1;
	}

	/** The header's button: as sharp as it gets, around the middle; or back to the whole screen. */
	function toggleZoom(): void {
		if (!frame) return;
		if (zoomed) {
			view = { zoom: 1, pan: { x: 0, y: 0 } };
			return;
		}
		// A screen small enough to be sharp already still gets closer. Around the trackpad pointer, when there is one.
		const sharp = Math.max(actualZoom(stage, frame, window.devicePixelRatio || 1), 2);
		view = zoomAround(stage, frame, view, pointerShown ?? { x: stage.w / 2, y: stage.h / 2 }, sharp, zoomLimit());
	}

	type GestureDetail = { type: string; clientX: number; clientY: number; magnitudeX?: number; magnitudeY?: number };
	let gesture: { kind: 'pinch' | 'pan'; from: ZoomView; distance: number; anchor: Point } | null = null;

	/**
	 * noVNC's gesture events, taken on the way down to its canvas. A pinch is always the phone's;
	 * a two-finger drag is the phone's while zoomed in (it moves the view) and the Mac's otherwise
	 * (it scrolls there). Taps, long presses and one-finger drags always go through to the Mac.
	 */
	function onGesture(event: Event): void {
		const detail = (event as CustomEvent<GestureDetail>).detail;
		if (!detail || !stageEl) return;
		if (['onetap', 'twotap', 'threetap', 'drag', 'longpress'].includes(detail.type)) notePointer(detail.clientX, detail.clientY);
		const kind = detail.type === 'pinch' ? 'pinch' : detail.type === 'twodrag' ? 'pan' : null;
		if (!kind) return;
		if (event.type === 'gesturestart') {
			if (kind === 'pan' && !zoomed) return;
			measureFrame();
			if (!frame) return;
			const rect = stageEl.getBoundingClientRect();
			gesture = {
				kind,
				from: view,
				distance: Math.hypot(detail.magnitudeX ?? 0, detail.magnitudeY ?? 0) || 1,
				anchor: { x: detail.clientX - rect.left, y: detail.clientY - rect.top },
			};
		} else if (!gesture || gesture.kind !== kind) {
			return;
		}
		event.stopPropagation();
		if (event.type === 'gesturemove' && frame) {
			const moved = { x: detail.magnitudeX ?? 0, y: detail.magnitudeY ?? 0 };
			view = gesture.kind === 'pinch'
				? zoomAround(stage, frame, gesture.from, gesture.anchor, gesture.from.zoom * (Math.hypot(moved.x, moved.y) / gesture.distance), zoomLimit())
				: panBy(stage, frame, gesture.from, moved);
		} else if (event.type === 'gestureend') {
			gesture = null;
		}
	}

	/** Where a tap or drag noVNC handled put the Mac's pointer, so trackpad mode carries on from there. */
	function notePointer(clientX: number, clientY: number): void {
		const rect = screenEl?.getBoundingClientRect();
		if (!frame || !rect?.width || !rect.height) return;
		pointer = {
			x: clamp(((clientX - rect.left) / rect.width) * frame.w, 0, frame.w - 1),
			y: clamp(((clientY - rect.top) / rect.height) * frame.h, 0, frame.h - 1),
		};
	}

	function clamp(n: number, low: number, high: number): number {
		return Math.min(Math.max(n, low), high);
	}

	/**
	 * Trackpad mode takes every touch on the stage before noVNC's canvas can (capturing, on its
	 * ancestor), the black bars around the picture included: the whole glass is the trackpad.
	 */
	function onTouch(event: TouchEvent): void {
		if (!trackpad || phase !== 'live' || !stageEl) return;
		event.stopPropagation();
		// No mouse events after it, and so no focus taken from the field that holds the keyboard.
		if (event.cancelable) event.preventDefault();
		if (event.type === 'touchcancel') {
			gestures.cancel();
			return;
		}
		if (event.type === 'touchstart') measureFrame();
		const rect = stageEl.getBoundingClientRect();
		const fingers: Finger[] = [];
		for (const touch of Array.from(event.touches)) {
			if (touch.target instanceof Node && stageEl.contains(touch.target)) {
				fingers.push({ id: touch.identifier, x: touch.clientX - rect.left, y: touch.clientY - rect.top });
			}
		}
		gestures.update(fingers);
	}

	const WHEEL = { up: BUTTON.wheelUp, down: BUTTON.wheelDown, left: BUTTON.wheelLeft, right: BUTTON.wheelRight } as const;

	function onTrackpad(action: TrackpadAction): void {
		if (!frame || !stage.w || !stage.h) return;
		if (action.kind === 'pinch') {
			if (action.start || !pinchFrom) pinchFrom = view;
			view = zoomAround(stage, frame, pinchFrom, action.anchor, pinchFrom.zoom * action.scale, zoomLimit());
			return;
		}
		// The pointer is where the page shows it: zoomed in elsewhere, it comes into view first.
		const at = keepShown(stage, frame, view, pointer ?? { x: frame.w / 2, y: frame.h / 2 }, POINTER_MARGIN);
		if (action.kind === 'move') {
			// Gain 1 keeps the pointer level with the finger over the picture, at any zoom.
			const perMacPixel = boxFor(stage, frame, view).width / frame.w;
			const gain = pointerGain(action.speed) / perMacPixel;
			pointer = { x: clamp(at.x + action.dx * gain, 0, frame.w - 1), y: clamp(at.y + action.dy * gain, 0, frame.h - 1) };
			view = follow(stage, frame, view, pointer, POINTER_MARGIN);
			pointerOut.moveTo(pointer);
			return;
		}
		pointer = at;
		if (action.kind === 'click') {
			pointerOut.click(at, action.button === 'right' ? BUTTON.right : BUTTON.left);
		} else if (action.kind === 'press') {
			dragging = true;
			pointerOut.press(at, BUTTON.left);
			try { navigator.vibrate?.(15); } catch {}
		} else if (action.kind === 'release') {
			dragging = false;
			pointerOut.release(at, BUTTON.left);
		} else {
			pointerOut.wheel(at, WHEEL[action.direction]);
		}
	}

	function toggleTrackpad(): void {
		gestures.reset();
		trackpad = !trackpad;
		saveTrackpadMode(trackpad);
		showTip(trackpad ? t.screen.trackpadHint : null);
		if (trackpad) hideNoVncCursor();
	}

	function showTip(text: string | null): void {
		if (tipTimer) clearTimeout(tipTimer);
		tip = text;
		tipTimer = text ? setTimeout(() => { tip = null; tipTimer = null; }, 6000) : null;
	}

	/** The Mac takes the request when the session starts: a connection under way starts again. */
	function toggleSmooth(): void {
		smooth = !smooth;
		saveScreenFlag('smooth', smooth);
		if (phase === 'live' || phase === 'connecting' || phase === 'signin') void start();
	}

	function smoothText(answer: SmoothResult | null): string {
		if (!answer) return t.screen.smoothUnsupported;
		if (answer.applied) return t.screen.smoothApplied(`${answer.width}×${answer.height}`);
		return answer.reason === 'already_low' ? t.screen.smoothAlreadyLow : t.screen.smoothFailed;
	}

	/**
	 * When Screen Sharing sends its cursor's shape, noVNC draws it where a finger last touched;
	 * in trackpad mode that spot goes stale and this page draws the pointer. noVNC has no call
	 * for hiding it, hence the reach into its internals, which does nothing should they change.
	 */
	function hideNoVncCursor(): void {
		try { (rfb as unknown as { _cursor?: { _hideCursor?: () => void } } | null)?._cursor?._hideCursor?.(); } catch {}
	}

	function signIn(event: SubmitEvent): void {
		event.preventDefault();
		const credentials = { ...(needsUsername ? { username } : {}), password };
		remembered = credentials;
		if (!keepSignIn) void remember?.forget();
		if (rfb && problem !== t.screen.wrongPassword) {
			rfb.sendCredentials(credentials);
			phase = 'connecting';
			awaitAnswer(rfb);
			return;
		}
		void start();
	}

	function send(keysym: number, down: boolean): void {
		rfb?.sendKey(keysym, null, down);
	}

	function takeArmed(): Modifier[] {
		const held = armed;
		armed = [];
		return held;
	}

	function toggleModifier(id: Modifier): void {
		armed = armed.includes(id) ? armed.filter((m) => m !== id) : [...armed, id];
	}

	function toggleKeyboard(): void {
		if (keyboardUp) inputEl?.blur();
		else inputEl?.focus({ preventScroll: true });
	}

	/**
	 * What the soft keyboard did, read off the field rather than off key events: an Android IME
	 * reports most keys as 229 and composes in place, so the field's text is the only honest
	 * record. A one-space sentinel stays in it so Backspace on "nothing" still has something to
	 * delete and shows up here.
	 */
	function onInput(event: Event): void {
		const input = event.currentTarget as HTMLInputElement;
		if ((event as InputEvent).isComposing) return;
		const next = input.value;
		let common = 0;
		while (common < typed.length && common < next.length && typed[common] === next[common]) common++;
		const removed = typed.length - common;
		const added = next.slice(common);
		const modifiers = takeArmed();
		for (let i = 0; i < removed; i++) press(send, KEYSYM.backspace, i === 0 ? modifiers : []);
		typeText(send, added, removed ? [] : modifiers);
		input.value = SENTINEL;
		typed = SENTINEL;
	}

	const KEYDOWN: Record<string, number> = {
		Enter: KEYSYM.enter,
		Tab: KEYSYM.tab,
		Escape: KEYSYM.escape,
		ArrowLeft: KEYSYM.left,
		ArrowUp: KEYSYM.up,
		ArrowRight: KEYSYM.right,
		ArrowDown: KEYSYM.down,
		Delete: KEYSYM.delete,
	};

	/** Keys that change nothing in the field: Enter in a single line, and a tablet keyboard's extras. */
	function onKeydown(event: KeyboardEvent): void {
		const keysym = KEYDOWN[event.key];
		if (keysym === undefined || event.isComposing) return;
		event.preventDefault();
		press(send, keysym, takeArmed());
	}

	function onVisibility(): void {
		if (document.visibilityState === 'hidden') {
			if (phase === 'live' || phase === 'connecting' || phase === 'signin') {
				attempt++;
				teardown();
				phase = 'paused';
			}
		} else if (phase === 'paused') {
			void start();
		}
	}

	onMount(() => {
		void start();
		document.addEventListener('visibilitychange', onVisibility);
		measureStage();
		const resize = typeof ResizeObserver === 'function' ? new ResizeObserver(() => measureStage()) : null;
		if (stageEl) resize?.observe(stageEl);
		// Capturing, on an ancestor of noVNC's canvas: it runs before noVNC's own listener can.
		for (const type of ['gesturestart', 'gesturemove', 'gestureend']) screenEl?.addEventListener(type, onGesture, true);
		const touches = ['touchstart', 'touchmove', 'touchend', 'touchcancel'];
		for (const type of touches) stageEl?.addEventListener(type, onTouch as EventListener, { capture: true, passive: false });
		// noVNC resizes its canvas when Screen Sharing announces a new framebuffer size.
		const resized = typeof MutationObserver === 'function' ? new MutationObserver(() => { if (phase === 'live') measureFrame(); }) : null;
		if (screenEl) resized?.observe(screenEl, { subtree: true, attributes: true, attributeFilter: ['width', 'height'] });
		return () => {
			resized?.disconnect();
			resize?.disconnect();
			for (const type of ['gesturestart', 'gesturemove', 'gestureend']) screenEl?.removeEventListener(type, onGesture, true);
			for (const type of touches) stageEl?.removeEventListener(type, onTouch as EventListener, true);
			if (tipTimer) clearTimeout(tipTimer);
			document.removeEventListener('visibilitychange', onVisibility);
			attempt++;
			teardown();
		};
	});
</script>

<div class="screen-pane">
	<header class="screen-head">
		<button type="button" class="screen-icon screen-back" aria-label={t.common.back} title={t.common.back} onclick={onClose}>
			<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="15 18 9 12 15 6"></polyline></svg>
		</button>
		<div class="screen-title">
			<span>{t.screen.title}</span>
			{#if phase === 'live' && route}
				<span class="screen-route" class:is-relay={route === 'relay'} title={route === 'relay' ? t.screen.relayHint : undefined}>
					{route === 'relay' ? t.screen.relay : t.screen.direct}
				</span>
			{/if}
		</div>
		{#if phase === 'live'}
			<button
				type="button"
				class="screen-text-button screen-mode"
				aria-pressed={trackpad}
				title={t.screen.trackpadTitle}
				onclick={toggleTrackpad}
			>{t.screen.trackpad}</button>
			<button
				type="button"
				class="screen-text-button screen-mode screen-smooth"
				aria-pressed={smooth}
				title={t.screen.smoothTitle}
				onclick={toggleSmooth}
			>{t.screen.smooth}</button>
			<button
				type="button"
				class="screen-text-button screen-zoom"
				aria-pressed={zoomed}
				onclick={toggleZoom}
			>{zoomed ? t.screen.fit : t.screen.actualSize}</button>
		{/if}
		{#if phase === 'live' || phase === 'connecting' || phase === 'signin'}
			<button type="button" class="screen-text-button" onclick={() => { attempt++; teardown(); phase = 'ended'; }}>{t.screen.disconnect}</button>
		{/if}
	</header>

	<div class="screen-stage" class:is-trackpad={trackpad && phase === 'live'} bind:this={stageEl}>
		<div
			class="screen-canvas"
			class:is-hidden={phase !== 'live'}
			bind:this={screenEl}
			style:width={box ? `${box.width}px` : null}
			style:height={box ? `${box.height}px` : null}
			style:left={box ? `${box.left}px` : null}
			style:top={box ? `${box.top}px` : null}
		></div>
		{#if phase === 'live' && pointerShown}
			<div
				class="screen-pointer"
				class:is-down={dragging}
				style:transform={`translate(${pointerShown.x}px, ${pointerShown.y}px)`}
				aria-hidden="true"
			>
				<svg width="20" height="24" viewBox="-2 -2 20 24" aria-hidden="true">
					<path d="M0 0v16.5l4.4-4.2 3 6.8 2.8-1.2-2.9-6.7h6.2z" fill="#fff" stroke="#000" stroke-width="1.4" stroke-linejoin="round"></path>
				</svg>
			</div>
		{/if}
		{#if phase === 'live' && tip}
			<p class="screen-tip" role="status">{tip}</p>
		{/if}
		{#if phase === 'live' && transfer}
			<p class="screen-transfer" role="status">{t.screen.receiving(megabytes(transfer.total), megabytes(transfer.rate))}</p>
		{/if}
		{#if phase === 'connecting'}
			<p class="screen-note" role="status">
				{step === 'loading' ? t.screen.loading : step === 'linking' ? t.screen.linking : t.screen.waitingMac}
			</p>
		{:else if phase === 'signin'}
			<form class="screen-signin" onsubmit={signIn}>
				<h2>{t.screen.signInTitle}</h2>
				<p class="screen-hint">{t.screen.signInHint}</p>
				{#if problem}<p class="screen-problem" role="alert">{problem}</p>{/if}
				{#if needsUsername}
					<label>
						<span>{t.screen.username}</span>
						<input type="text" bind:value={username} autocomplete="username" autocapitalize="off" spellcheck="false" required />
					</label>
				{/if}
				<label>
					<span>{t.screen.password}</span>
					<input type="password" bind:value={password} autocomplete="current-password" required />
				</label>
				{#if remember}
					<label class="screen-keep">
						<input type="checkbox" bind:checked={keepSignIn} />
						<span>{t.screen.keepSignIn}</span>
					</label>
				{/if}
				<button type="submit" class="screen-primary">{t.screen.signIn}</button>
			</form>
		{:else if phase === 'ended' || phase === 'failed' || phase === 'paused'}
			<div class="screen-note">
				<p role="status">{phase === 'failed' ? problem : phase === 'paused' ? t.screen.paused : t.screen.ended}</p>
				<button type="button" class="screen-primary" onclick={() => void start()}>{t.screen.reconnect}</button>
			</div>
		{/if}
	</div>

	{#if phase === 'live'}
		<!-- svelte-ignore a11y_no_static_element_interactions -->
		<div
			class="screen-keys"
			role="toolbar"
			tabindex="-1"
			aria-label={t.screen.keys}
			onmousedown={(event) => event.preventDefault()}
		>
			<button type="button" class="screen-key is-action" aria-pressed={keyboardUp} aria-label={t.screen.keyboard} onclick={toggleKeyboard}>
				<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
					<rect x="2" y="4" width="20" height="12" rx="2"></rect>
					<path d="M6 8h.01M10 8h.01M14 8h.01M18 8h.01M7 12h10"></path>
				</svg>
			</button>
			{#each MODIFIERS as modifier (modifier.id)}
				<button
					type="button"
					class="screen-key"
					class:is-armed={armed.includes(modifier.id)}
					aria-pressed={armed.includes(modifier.id)}
					aria-label={t.screen.modifier(modifier.name)}
					data-key={modifier.id}
					onclick={() => toggleModifier(modifier.id)}
				>{modifier.label}</button>
			{/each}
			{#each SCREEN_KEYS as key (key.id)}
				<button type="button" class="screen-key" data-key={key.id} onclick={() => press(send, key.keysym, takeArmed())}>{key.label}</button>
			{/each}
		</div>
		<input
			bind:this={inputEl}
			class="screen-input"
			type="text"
			value={SENTINEL}
			aria-label={t.screen.keyboard}
			autocomplete="off"
			autocapitalize="off"
			spellcheck="false"
			enterkeyhint="send"
			oninput={onInput}
			onkeydown={onKeydown}
			onfocus={() => (keyboardUp = true)}
			onblur={() => (keyboardUp = false)}
		/>
	{/if}
</div>

<style>
	.screen-pane {
		position: relative;
		display: flex;
		flex-direction: column;
		height: 100%;
		min-height: 0;
		background: var(--pane);
	}

	.screen-head {
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 6px 8px;
		padding-top: max(6px, env(safe-area-inset-top));
		border-bottom: 1px solid var(--line);
	}

	.screen-title {
		display: flex;
		align-items: center;
		gap: 8px;
		flex: 1 1 auto;
		min-width: 0;
		overflow: hidden;
		font-weight: 600;
		white-space: nowrap;
	}

	/* Four buttons share a phone's header: the title gives way first. */
	.screen-title > span:first-child {
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.screen-route {
		flex: 0 0 auto;
		padding: 1px 6px;
		border-radius: 999px;
		background: var(--accent-tint);
		color: var(--muted);
		font-size: 11px;
		font-weight: 500;
	}

	.screen-icon,
	.screen-text-button {
		flex: 0 0 auto;
		border: none;
		background: transparent;
		color: inherit;
		cursor: pointer;
	}

	.screen-icon {
		display: grid;
		place-items: center;
		width: 36px;
		height: 36px;
		border-radius: var(--radius-sm);
	}

	.screen-text-button {
		padding: 6px 8px;
		border-radius: var(--radius-sm);
		font-size: 13px;
	}

	.screen-mode[aria-pressed='true'] {
		background: var(--accent-tint);
		color: var(--accent);
	}

	.screen-text-button:disabled {
		opacity: 0.4;
		cursor: default;
	}

	.screen-stage {
		position: relative;
		flex: 1 1 auto;
		min-height: 0;
		overflow: hidden;
		background: #000;
	}

	/* The picture's box: the whole stage until the screen's size is known, then placed by zoom and pan. */
	.screen-canvas {
		position: absolute;
		inset: 0;
		/* noVNC fits its canvas to this box; touch handling is its own (and ours, for pinch). */
		touch-action: none;
	}

	.screen-canvas.is-hidden {
		visibility: hidden;
	}

	/* The whole stage is the trackpad, bars and all: no page scroll or zoom from it. */
	.screen-stage.is-trackpad {
		touch-action: none;
	}

	/* Its tip, 2px into the box, is the pointer's spot. */
	.screen-pointer {
		position: absolute;
		left: -2px;
		top: -2px;
		width: 20px;
		height: 24px;
		pointer-events: none;
		filter: drop-shadow(0 1px 1px rgba(0, 0, 0, 0.4));
	}

	.screen-pointer svg {
		position: relative;
		display: block;
	}

	/* The button held for a drag. */
	.screen-pointer.is-down::before {
		content: '';
		position: absolute;
		left: -10px;
		top: -10px;
		box-sizing: border-box;
		width: 24px;
		height: 24px;
		border: 2px solid #fff;
		border-radius: 50%;
		background: color-mix(in srgb, var(--accent) 55%, transparent);
	}

	.screen-tip {
		position: absolute;
		left: 50%;
		top: 12px;
		transform: translateX(-50%);
		width: max-content;
		max-width: calc(100% - 32px);
		margin: 0;
		padding: 6px 12px;
		border-radius: 12px;
		background: rgba(0, 0, 0, 0.7);
		color: #fff;
		font-size: 12px;
		line-height: 1.5;
		text-align: center;
		pointer-events: none;
	}

	.screen-note,
	.screen-signin {
		position: absolute;
		inset: 0;
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		gap: 12px;
		padding: 24px;
		margin: 0;
		background: var(--pane);
		color: var(--ink);
		text-align: center;
	}

	.screen-signin {
		align-items: stretch;
		max-width: 360px;
		margin: 0 auto;
		text-align: left;
	}

	.screen-signin h2 {
		margin: 0;
		font-size: 17px;
	}

	.screen-signin label {
		display: flex;
		flex-direction: column;
		gap: 4px;
		font-size: 13px;
		color: var(--muted);
	}

	.screen-signin input {
		padding: 8px 10px;
		border: 1px solid var(--line);
		border-radius: var(--radius-sm);
		background: var(--input-bg);
		color: var(--ink);
		font-size: 16px;
	}

	.screen-signin .screen-keep {
		flex-direction: row;
		align-items: center;
		gap: 8px;
		color: var(--ink);
	}

	.screen-transfer {
		position: absolute;
		left: 50%;
		bottom: 12px;
		transform: translateX(-50%);
		margin: 0;
		padding: 4px 10px;
		border-radius: 999px;
		background: rgba(0, 0, 0, 0.6);
		color: #fff;
		font-size: 12px;
		white-space: nowrap;
		pointer-events: none;
	}

	.screen-hint {
		margin: 0;
		font-size: 13px;
		color: var(--muted);
	}

	.screen-problem {
		margin: 0;
		color: var(--danger-text);
		font-size: 13px;
	}

	.screen-primary {
		padding: 8px 16px;
		border: none;
		border-radius: var(--radius-sm);
		background: var(--accent);
		color: var(--on-accent);
		font-size: 15px;
		cursor: pointer;
	}

	.screen-keys {
		display: flex;
		gap: 4px;
		padding: 6px 8px;
		padding-bottom: max(6px, env(safe-area-inset-bottom));
		overflow-x: auto;
		border-top: 1px solid var(--line);
		background: var(--pane);
	}

	/* Eleven keys share the row; on the narrowest phones it scrolls rather than squeezing a key. */
	.screen-key {
		flex: 1 0 30px;
		min-width: 30px;
		height: 36px;
		padding: 0 4px;
		border: 1px solid var(--line);
		border-radius: var(--radius-sm);
		background: var(--input-bg);
		color: inherit;
		font-size: 15px;
		cursor: pointer;
	}

	.screen-key.is-armed,
	.screen-key[aria-pressed='true'] {
		border-color: var(--accent);
		color: var(--accent);
	}

	.screen-key.is-action {
		display: grid;
		place-items: center;
	}

	/* Holds the soft keyboard. Off the visible page, never off the document, or it cannot take focus. */
	.screen-input {
		position: absolute;
		left: 0;
		bottom: 0;
		width: 1px;
		height: 1px;
		opacity: 0;
		border: 0;
		padding: 0;
		font-size: 16px;
	}
</style>
