import type { Copy } from '../copy.ts';
import { ApiError } from '../api.ts';
import type { MessengerApi } from '../messenger-api.ts';
import { RecorderFailure, VoiceRecorder, blobToBase64, type Recording } from './voice-recorder.ts';

/**
 * The composer's microphone (ADR 0073): press to record, press again to stop; the recording goes
 * to the daemon, and what the speech endpoint heard lands in the box where the caret was, in the
 * conversation it was recorded for. Nothing is sent to anyone until you send it.
 */
export type VoicePhase = 'idle' | 'starting' | 'recording' | 'transcribing';

export type ComposerVoiceHost = {
	api: () => MessengerApi | null;
	t: () => Copy;
	/** The conversation the composer is on now. */
	sessionId: () => string | null;
	/** Remembers where the caret is, before recording takes the focus. */
	markCaret: () => void;
	/** Puts what was heard into that conversation's box. */
	insert: (sessionId: string, text: string) => void;
	makeRecorder?: () => VoiceRecorder;
};

/** Text joined onto what is already there: a space between Latin words, none for Chinese or after a space. */
export function spacedHeard(before: string, heard: string): string {
	const last = before.slice(-1);
	const first = heard.charAt(0);
	if (!last || /\s/.test(last) || !first) return heard;
	return /[\p{Script=Latin}\p{N}.,!?;:)]/u.test(last) && /[\p{Script=Latin}\p{N}]/u.test(first) ? ` ${heard}` : heard;
}

/** A copy of the selection when it is inside the editor, else null. */
export function caretIn(editor: HTMLElement | null): Range | null {
	const sel = typeof window !== 'undefined' ? window.getSelection() : null;
	return editor && sel && sel.rangeCount > 0 && editor.contains(sel.anchorNode) ? sel.getRangeAt(0).cloneRange() : null;
}

/**
 * Puts what was heard into the editor like a paste: at `caret` while it is still inside, else at
 * the end; the caret follows it when the editor has the focus. The caller syncs the draft.
 */
export function insertHeardAt(editor: HTMLElement, caret: Range | null, heard: string): void {
	const at = caret && editor.contains(caret.startContainer) ? caret : document.createRange();
	if (at !== caret) {
		at.selectNodeContents(editor);
		at.collapse(false);
	}
	const lead = document.createRange();
	lead.setStart(editor, 0);
	lead.setEnd(at.startContainer, at.startOffset);
	const node = document.createTextNode(spacedHeard(lead.toString(), heard));
	at.deleteContents();
	at.insertNode(node);
	if (document.activeElement !== editor) return;
	const sel = window.getSelection();
	const after = document.createRange();
	after.setStartAfter(node);
	after.collapse(true);
	sel?.removeAllRanges();
	sel?.addRange(after);
}

/** What to say for a failed transcription, from the daemon's error code (`speech.ts` there). */
export function transcribeFailureText(error: unknown, t: Copy): string {
	const s = t.speech;
	if (error instanceof ApiError) {
		const detail = error.message.replace(/^the speech endpoint answered\s*/i, '');
		switch (error.code) {
			case 'speech_not_set_up':
				return s.notSetUp;
			case 'speech_key_missing':
				return s.keyMissing;
			case 'speech_rejected':
				return s.rejected(detail);
			case 'speech_unreachable':
				return s.unreachable;
			case 'speech_timeout':
				return s.timeout;
			case 'speech_too_long':
				return s.tooLong;
			case 'speech_audio_unsupported':
				return s.audioUnsupported;
		}
		return s.transcribeFailed(detail);
	}
	return s.transcribeFailed(error instanceof Error ? error.message : String(error));
}

export function recorderFailureText(error: unknown, t: Copy): string {
	const s = t.speech;
	if (error instanceof RecorderFailure) {
		if (error.kind === 'denied') return s.micDenied;
		if (error.kind === 'missing') return s.micMissing;
		if (error.kind === 'unsupported') return s.micUnsupported;
		return s.micFailed(error.message);
	}
	return s.micFailed(error instanceof Error ? error.message : String(error));
}

export class ComposerVoice {
	phase = $state<VoicePhase>('idle');
	seconds = $state(0);
	level = $state(0);
	/** A failure or "heard nothing", until dismissed or the next recording. */
	notice = $state<string | null>(null);
	private recorder: VoiceRecorder | null = null;
	private aborter: AbortController | null = null;
	private sessionId: string | null = null;
	/** Bumped by cancel, so a recording or transcription that finishes afterwards is dropped. */
	private generation = 0;

	constructor(private readonly host: ComposerVoiceHost) {}

	get busy(): boolean {
		return this.phase !== 'idle';
	}

	toggle(): Promise<void> {
		if (this.phase === 'idle') return this.start();
		if (this.phase === 'recording') return this.stop();
		return Promise.resolve();
	}

	async start(): Promise<void> {
		if (this.phase !== 'idle') return;
		const sessionId = this.host.sessionId();
		if (!sessionId) return;
		this.host.markCaret();
		this.notice = null;
		this.sessionId = sessionId;
		this.seconds = 0;
		this.level = 0;
		this.phase = 'starting';
		const generation = ++this.generation;
		const recorder = this.host.makeRecorder?.() ?? new VoiceRecorder();
		this.recorder = recorder;
		try {
			await recorder.start({
				onTick: (seconds) => {
					if (generation === this.generation) this.seconds = seconds;
				},
				onLevel: (level) => {
					if (generation === this.generation) this.level = level;
				},
				onLimit: () => {
					if (generation === this.generation) void this.stop();
				}
			});
		} catch (error) {
			if (generation !== this.generation) return;
			this.recorder = null;
			this.phase = 'idle';
			this.notice = recorderFailureText(error, this.host.t());
			return;
		}
		if (generation !== this.generation) {
			recorder.cancel();
			return;
		}
		this.phase = 'recording';
	}

	async stop(): Promise<void> {
		const recorder = this.recorder;
		const sessionId = this.sessionId;
		if (this.phase !== 'recording' || !recorder || !sessionId) return;
		const generation = this.generation;
		this.phase = 'transcribing';
		this.level = 0;
		this.recorder = null;
		let recording: Recording;
		try {
			recording = await recorder.stop();
		} catch (error) {
			if (generation !== this.generation) return;
			this.phase = 'idle';
			this.notice = recorderFailureText(error, this.host.t());
			return;
		}
		if (generation !== this.generation) return;
		await this.transcribe(recording, sessionId, generation);
	}

	private async transcribe(recording: Recording, sessionId: string, generation: number): Promise<void> {
		const t = this.host.t();
		const api = this.host.api();
		if (!api) {
			this.phase = 'idle';
			this.notice = t.speech.unreachable;
			return;
		}
		if (recording.blob.size === 0) {
			this.phase = 'idle';
			this.notice = t.speech.heardNothing;
			return;
		}
		this.aborter = new AbortController();
		try {
			const audio = await blobToBase64(recording.blob);
			const { text } = await api.transcribe({ audio, mime: recording.mime }, this.aborter.signal);
			if (generation !== this.generation) return;
			const heard = text.trim();
			if (heard) this.host.insert(sessionId, heard);
			else this.notice = t.speech.heardNothing;
		} catch (error) {
			if (generation !== this.generation) return;
			this.notice = transcribeFailureText(error, t);
		} finally {
			if (generation === this.generation) {
				this.aborter = null;
				this.phase = 'idle';
			}
		}
	}

	/** Drops the recording, or stops waiting for its text; the microphone is let go at once. */
	cancel(): void {
		this.generation++;
		this.recorder?.cancel();
		this.recorder = null;
		this.aborter?.abort();
		this.aborter = null;
		this.phase = 'idle';
		this.level = 0;
		this.seconds = 0;
	}

	dismiss(): void {
		this.notice = null;
	}
}
