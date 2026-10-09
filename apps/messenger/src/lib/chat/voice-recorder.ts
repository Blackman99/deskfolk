import { SPEECH_AUDIO_BASE64_MAX, SPEECH_MAX_SECONDS } from '@real-bot/protocol';

/**
 * The composer's microphone (ADR 0073): records compressed audio with the browser's own
 * `MediaRecorder` — webm/opus in Chrome, mp4 in WebKit — and stops by itself before the recording
 * outgrows what one transcription may carry. The speech endpoint gets the audio as recorded.
 */

/** Recorded bytes one transcription may carry: base64 grows by a third, and a margin stays for the JSON. */
export const SPEECH_RAW_BYTES_MAX = Math.floor((SPEECH_AUDIO_BASE64_MAX * 3) / 4) - 16 * 1024;

/** Speech needs little: a low bit rate keeps minutes inside one transcription. */
const BITS_PER_SECOND = 32_000;

const PREFERRED_TYPES = ['audio/webm;codecs=opus', 'audio/ogg;codecs=opus', 'audio/mp4', 'audio/webm', 'audio/ogg'];

export type RecorderFailureKind = 'denied' | 'missing' | 'unsupported' | 'failed';

export class RecorderFailure extends Error {
	constructor(
		readonly kind: RecorderFailureKind,
		message: string
	) {
		super(message);
	}
}

export type Recording = { blob: Blob; mime: string; seconds: number };

export type RecorderHooks = {
	/** Seconds since recording started, a few times a second. */
	onTick?: (seconds: number) => void;
	/** How loud it is now, 0–1. */
	onLevel?: (level: number) => void;
	/** The time or size limit was reached; the caller stops and transcribes. */
	onLimit?: () => void;
};

/** Recording needs the microphone API and a recorder; neither exists outside a secure page. */
export function recorderSupported(): boolean {
	return typeof navigator !== 'undefined' && Boolean(navigator.mediaDevices?.getUserMedia) && typeof MediaRecorder !== 'undefined';
}

/** The first compressed type this browser records; '' lets it choose. */
export function pickRecorderType(isTypeSupported: (type: string) => boolean): string {
	return PREFERRED_TYPES.find((type) => {
		try {
			return isTypeSupported(type);
		} catch {
			return false;
		}
	}) ?? '';
}

/** What the daemon is told the recording is: audio-only, so a `video/` label becomes `audio/`. */
export function recordingMime(type: string): string {
	const trimmed = type.trim();
	if (!trimmed) return 'audio/webm';
	return trimmed.replace(/^video\//i, 'audio/');
}

/** `m:ss`. */
export function formatClock(seconds: number): string {
	const whole = Math.max(0, Math.floor(seconds));
	return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`;
}

export async function blobToBase64(blob: Blob): Promise<string> {
	const bytes = new Uint8Array(await blob.arrayBuffer());
	let binary = '';
	const step = 0x8000;
	for (let at = 0; at < bytes.length; at += step) binary += String.fromCharCode(...bytes.subarray(at, at + step));
	return btoa(binary);
}

function failureOf(error: unknown): RecorderFailure {
	const name = error instanceof DOMException || (error && typeof error === 'object' && 'name' in error) ? String((error as { name: unknown }).name) : '';
	const message = error instanceof Error ? error.message : String(error);
	if (name === 'NotAllowedError' || name === 'SecurityError' || name === 'PermissionDeniedError') return new RecorderFailure('denied', message);
	if (name === 'NotFoundError' || name === 'OverconstrainedError' || name === 'DevicesNotFoundError') return new RecorderFailure('missing', message);
	return new RecorderFailure('failed', message || name || 'recording failed');
}

export class VoiceRecorder {
	private stream: MediaStream | null = null;
	private recorder: MediaRecorder | null = null;
	private chunks: Blob[] = [];
	private bytes = 0;
	private startedAt = 0;
	private ticker: ReturnType<typeof setInterval> | null = null;
	private audio: AudioContext | null = null;
	private frame = 0;
	private limited = false;

	async start(hooks: RecorderHooks = {}): Promise<void> {
		if (!recorderSupported()) throw new RecorderFailure('unsupported', 'recording is not available on this page');
		try {
			this.stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
		} catch (error) {
			throw failureOf(error);
		}
		const type = pickRecorderType((candidate) => MediaRecorder.isTypeSupported(candidate));
		try {
			this.recorder = new MediaRecorder(this.stream, { ...(type ? { mimeType: type } : {}), audioBitsPerSecond: BITS_PER_SECOND });
		} catch (error) {
			this.release();
			throw failureOf(error);
		}
		this.chunks = [];
		this.bytes = 0;
		this.limited = false;
		this.recorder.ondataavailable = (event) => {
			if (!event.data || event.data.size === 0) return;
			this.chunks.push(event.data);
			this.bytes += event.data.size;
			// Some recorders ignore the bit rate asked for; the size is what has to fit.
			if (this.bytes >= SPEECH_RAW_BYTES_MAX * 0.9) this.limit(hooks);
		};
		this.startedAt = Date.now();
		this.recorder.start(1000);
		this.ticker = setInterval(() => {
			const seconds = (Date.now() - this.startedAt) / 1000;
			hooks.onTick?.(seconds);
			if (seconds >= SPEECH_MAX_SECONDS) this.limit(hooks);
		}, 250);
		this.meter(hooks);
	}

	private limit(hooks: RecorderHooks): void {
		if (this.limited) return;
		this.limited = true;
		hooks.onLimit?.();
	}

	/** A level for the button to breathe with; recording goes on without it where Web Audio is missing. */
	private meter(hooks: RecorderHooks): void {
		if (!hooks.onLevel || !this.stream) return;
		const Context = (globalThis as { AudioContext?: typeof AudioContext; webkitAudioContext?: typeof AudioContext }).AudioContext
			?? (globalThis as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
		if (!Context || typeof requestAnimationFrame === 'undefined') return;
		try {
			this.audio = new Context();
			const analyser = this.audio.createAnalyser();
			analyser.fftSize = 512;
			this.audio.createMediaStreamSource(this.stream).connect(analyser);
			const samples = new Uint8Array(analyser.fftSize);
			const read = () => {
				analyser.getByteTimeDomainData(samples);
				let sum = 0;
				for (const sample of samples) sum += ((sample - 128) / 128) ** 2;
				hooks.onLevel?.(Math.min(1, Math.sqrt(sum / samples.length) * 4));
				this.frame = requestAnimationFrame(read);
			};
			this.frame = requestAnimationFrame(read);
		} catch {
			this.audio = null;
		}
	}

	stop(): Promise<Recording> {
		const recorder = this.recorder;
		if (!recorder) return Promise.reject(new RecorderFailure('failed', 'not recording'));
		const seconds = (Date.now() - this.startedAt) / 1000;
		return new Promise((resolve, reject) => {
			recorder.onstop = () => {
				const mime = recordingMime(recorder.mimeType || this.chunks[0]?.type || '');
				const blob = new Blob(this.chunks, { type: mime });
				this.release();
				resolve({ blob, mime, seconds });
			};
			recorder.onerror = (event) => {
				this.release();
				reject(failureOf((event as Event & { error?: unknown }).error ?? event));
			};
			try {
				if (recorder.state === 'inactive') recorder.onstop?.(new Event('stop'));
				else recorder.stop();
			} catch (error) {
				this.release();
				reject(failureOf(error));
			}
		});
	}

	/** Drops the recording and lets go of the microphone. */
	cancel(): void {
		const recorder = this.recorder;
		if (recorder) {
			recorder.ondataavailable = null;
			recorder.onstop = null;
			try {
				if (recorder.state !== 'inactive') recorder.stop();
			} catch {
				// Already stopped; the tracks are released below either way.
			}
		}
		this.release();
	}

	private release(): void {
		if (this.ticker) clearInterval(this.ticker);
		this.ticker = null;
		if (this.frame && typeof cancelAnimationFrame !== 'undefined') cancelAnimationFrame(this.frame);
		this.frame = 0;
		void this.audio?.close().catch(() => undefined);
		this.audio = null;
		for (const track of this.stream?.getTracks() ?? []) track.stop();
		this.stream = null;
		this.recorder = null;
	}
}
