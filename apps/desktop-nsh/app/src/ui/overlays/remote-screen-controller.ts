/**
 * The remote screen page's state and its connection life, apart from how it is drawn: the
 * `<script>` of `RemoteScreenView.svelte` with the native RFB client (`ScreenSession`) where noVNC
 * was. A connection goes loading, linking, then waits on the Mac's answer; the Mac asks for its
 * account or shows the screen; a drop, a refusal or a silence ends in a state the page can
 * reconnect from. The account password Screen Sharing asks for stays in memory, to sign straight
 * back in after a drop.
 */
import { signal, type Signal } from "nsh";
import type { Copy } from "../../m/copy.ts";
import { ApiError } from "../../m/api.ts";
import { connectScreen, type ScreenApi, type ScreenConnection, type SmoothResult } from "../../m/remote/screen-connect.ts";
import type { RememberedSignIn } from "../../m/remote/screen-sign-in.ts";
import { loadScreenFlag, saveScreenFlag } from "../../m/overlays/screen-prefs.ts";
import { loadTrackpadMode, saveTrackpadMode, type Point } from "../../m/overlays/screen-trackpad.ts";
import { PointerOut } from "../../m/overlays/screen-pointer.ts";
import type { Modifier } from "../../m/overlays/remote-screen-keys.ts";
import { actualZoom, boxFor, keepShown, maxZoom, zoomAround, type Size, type ZoomView } from "../../m/overlays/screen-zoom.ts";
import { ScreenSession, type ScreenEvent } from "./remote-screen-session.ts";

export type Phase = "connecting" | "signin" | "live" | "ended" | "failed" | "paused";
/** Where a connection is while it is connecting, so a page that stays on it says which step. */
export type Step = "loading" | "linking" | "answer";

export type ScreenViewApi = ScreenApi & {
  screenStatus(sessionId: string): Promise<{ mode: string }>;
  screenStop(sessionId: string): Promise<void>;
};

export type ControllerOptions = {
  api: ScreenViewApi;
  /** The page's words (`screenCopy(copy(), host)`), read when they are needed. */
  words: () => Copy["screen"];
  connect?: typeof connectScreen;
  keepaliveMs?: number;
  answerMs?: number;
  remember?: RememberedSignIn;
  host: "mac" | "windows";
};

export const WHOLE: ZoomView = { zoom: 1, pan: { x: 0, y: 0 } };
/** How far the trackpad pointer keeps from a stage edge the picture runs past, in points. */
export const POINTER_MARGIN = 40;

const clamp = (n: number, low: number, high: number): number => Math.min(Math.max(n, low), high);

export class ScreenController {
  readonly phase = signal<Phase>("connecting");
  readonly step = signal<Step>("loading");
  readonly route = signal<ScreenConnection["mode"] | null>(null);
  readonly problem = signal<string | null>(null);
  readonly needsUsername = signal(true);
  readonly username = signal("");
  readonly password = signal("");
  /** The stage the picture is shown on, and the picture's own size once the Mac announced it. */
  readonly stage = signal<Size>({ w: 0, h: 0 });
  readonly frame = signal<Size | null>(null);
  /** Zoomed on the phone, never on the Mac. */
  readonly view = signal<ZoomView>(WHOLE);
  /** Whether a sign-in that gets in is kept for next time. */
  readonly keepSignIn = signal(true);
  /** Picture bytes arriving, while they do: a big first frame is a wait, not a broken screen. */
  readonly transfer = signal<{ total: number; rate: number } | null>(null);
  readonly trackpad = signal(loadTrackpadMode());
  /** Where the Mac's pointer is, as far as this page knows, in the Mac's pixels. */
  readonly pointer = signal<Point | null>(null);
  /** The left button held down by a drag. */
  readonly dragging = signal(false);
  readonly smooth = signal(loadScreenFlag("smooth"));
  /** A line said for a few seconds over the picture: the trackpad's gestures, smooth mode's answer. */
  readonly tip = signal<string | null>(null);
  /** The live connection's tiles (empty before one). */
  readonly session: Signal<ScreenSession | null> = signal<ScreenSession | null>(null);
  /** The key row's modifiers armed for the next key. */
  readonly armed = signal<Modifier[]>([]);
  readonly keyboardUp = signal(false);
  /** Whether the failed sign-in was the Mac refusing it (the form says so). */
  readonly refused = signal(false);

  readonly out = new PointerOut((bytes) => {
    const at = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    this.#session?.pointer(at.getUint16(2), at.getUint16(4), at.getUint8(1));
  });

  #session: ScreenSession | null = null;
  #connection: ScreenConnection | null = null;
  #keepalive: ReturnType<typeof setInterval> | null = null;
  #answerTimer: ReturnType<typeof setTimeout> | null = null;
  #meter: ReturnType<typeof setInterval> | null = null;
  #tipTimer: ReturnType<typeof setTimeout> | null = null;
  #rememberedLoaded = false;
  #remembered: { username?: string; password?: string } | null = null;
  #smoothAnswer: SmoothResult | null | undefined;
  #attempt = 0;
  #gone = false;
  /** Gestures to reset with a connection (the trackpad's, the touch reader's). */
  readonly resetters: Array<() => void> = [];

  constructor(private readonly options: ControllerOptions) {}

  get #connect(): typeof connectScreen {
    return this.options.connect ?? connectScreen;
  }

  get words(): Copy["screen"] {
    return this.options.words();
  }

  get host(): "mac" | "windows" {
    return this.options.host;
  }

  get remember(): RememberedSignIn | undefined {
    return this.options.remember;
  }

  /** The tile list of the live connection, for the stage. */
  tiles() {
    return this.session()?.tiles() ?? [];
  }

  #explain(error: unknown): string {
    const code = error instanceof ApiError ? error.code : null;
    if (code === "screen_disabled") return this.words.disabledOnMac;
    if (code === "screen_sharing_off") return this.words.sharingOff;
    return this.words.failed;
  }

  teardown(): void {
    if (this.#keepalive) clearInterval(this.#keepalive);
    this.#keepalive = null;
    this.#clearAnswerTimer();
    if (this.#meter) clearInterval(this.#meter);
    this.#meter = null;
    this.transfer.set(null);
    for (const reset of this.resetters) reset();
    this.out.reset();
    this.dragging.set(false);
    const held = this.#connection;
    this.#connection = null;
    const session = this.#session;
    this.#session = null;
    this.session.set(null);
    // The session closes its channel; a connection that never got one attached closes it here.
    if (session) session.close();
    else {
      try {
        held?.channel.close();
      } catch {
        // Already closed.
      }
    }
    if (held) void this.options.api.screenStop(held.sessionId).catch(() => {});
  }

  /** The page is leaving. */
  dispose(): void {
    this.#gone = true;
    if (this.#tipTimer) clearTimeout(this.#tipTimer);
    this.#attempt++;
    this.teardown();
  }

  async start(): Promise<void> {
    this.teardown();
    const mine = ++this.#attempt;
    this.phase.set("connecting");
    this.step.set("loading");
    this.problem.set(null);
    this.refused.set(false);
    this.route.set(null);
    this.showTip(null);
    try {
      if (!this.#rememberedLoaded && this.options.remember) {
        this.#rememberedLoaded = true;
        this.#remembered = await this.options.remember.load();
        if (this.#remembered?.username) this.username.set(this.#remembered.username);
        if (mine !== this.#attempt) return;
      }
      this.step.set("linking");
      const opened = await this.#connect(this.options.api, { smooth: this.smooth() && this.options.host === "mac" });
      if (mine !== this.#attempt || this.#gone) {
        opened.channel.close();
        void this.options.api.screenStop(opened.sessionId).catch(() => {});
        if (mine === this.#attempt) throw new Error("screen_unmounted");
        return;
      }
      this.#connection = opened;
      this.route.set(opened.mode);
      this.#smoothAnswer = opened.smooth;
      const session = new ScreenSession(opened.channel, (event) => this.#onEvent(session, event));
      this.#session = session;
      this.session.set(session);
      this.#awaitAnswer(session);
      this.#keepalive = setInterval(() => {
        const live = this.#connection;
        if (!live) return;
        this.options.api.screenStatus(live.sessionId).catch((error) => {
          if (this.#connection !== live) return;
          if (error instanceof ApiError && error.code === "screen_session_gone") {
            this.teardown();
            this.phase.set("ended");
          }
        });
      }, this.options.keepaliveMs ?? 15_000);
    } catch (error) {
      if (mine !== this.#attempt) return;
      this.teardown();
      this.problem.set(this.#explain(error));
      this.phase.set("failed");
    }
  }

  #onEvent(session: ScreenSession, event: ScreenEvent): void {
    if (this.#session !== session) return;
    switch (event.type) {
      case "credentials": {
        this.#clearAnswerTimer();
        const needsUsername = event.needs.includes("username");
        this.needsUsername.set(needsUsername);
        const kept = this.#remembered;
        // What a kept sign-in has is sent as it is, as noVNC does; the page asks only for what is missing.
        if (kept && kept.password !== undefined && (!needsUsername || kept.username)) {
          session.credentials(kept.username ?? "", kept.password);
          return;
        }
        this.phase.set("signin");
        return;
      }
      case "connected":
        this.#clearAnswerTimer();
        this.phase.set("live");
        this.#onSize(event.width, event.height);
        if (this.#smoothAnswer !== undefined) this.showTip(this.#smoothText(this.#smoothAnswer));
        // In: whatever got it in is kept, unless the person said not to.
        if (this.#remembered && this.keepSignIn()) {
          void this.options.remember?.save({ ...this.#remembered, password: this.#remembered.password ?? "" });
        }
        if (this.#connection) this.#watchTransfer(this.#connection);
        return;
      case "resized":
        this.#onSize(event.width, event.height);
        return;
      case "failed":
        if (event.securityFailure) {
          // A kept sign-in Screen Sharing no longer takes is forgotten, never retried.
          void this.options.remember?.forget();
          this.#remembered = null;
          this.password.set("");
          this.refused.set(true);
          this.problem.set(this.words.wrongPassword);
        }
        this.#finish();
        return;
      case "closed":
        this.#finish();
        return;
      default:
        return;
    }
  }

  /** The Mac ended it: the page goes back to asking when the account was refused, to "disconnected" otherwise. */
  #finish(): void {
    const signInFailed = this.refused();
    this.teardown();
    this.phase.set(signInFailed ? "signin" : "ended");
  }

  /**
   * The channel is up and the client is talking; Screen Sharing should ask for a password or show
   * the screen within seconds. One that says nothing is a dead end the page must not spin on.
   */
  #awaitAnswer(session: ScreenSession): void {
    this.step.set("answer");
    this.#clearAnswerTimer();
    this.#answerTimer = setTimeout(() => {
      if (this.#session !== session || this.phase() !== "connecting") return;
      this.#attempt++;
      this.teardown();
      this.problem.set(this.words.noAnswer);
      this.phase.set("failed");
    }, this.options.answerMs ?? 20_000);
  }

  #clearAnswerTimer(): void {
    if (this.#answerTimer) clearTimeout(this.#answerTimer);
    this.#answerTimer = null;
  }

  /** Samples the channel each second; shown while more than a trickle is arriving. */
  #watchTransfer(opened: ScreenConnection): void {
    if (this.#meter) clearInterval(this.#meter);
    let last = opened.channel.bytesIn ?? 0;
    this.#meter = setInterval(() => {
      const total = opened.channel.bytesIn ?? 0;
      const rate = total - last;
      last = total;
      this.transfer.set(rate > 16 * 1024 ? { total, rate } : null);
    }, 1000);
  }

  /** The picture's size, announced at the start and again when the Mac's resolution changes. */
  #onSize(width: number, height: number): void {
    if (!width || !height) return;
    const next = { w: width, h: height };
    const frame = this.frame();
    if (frame && (frame.w !== next.w || frame.h !== next.h)) {
      // A new size (smooth mode, or the Mac's own resolution changed): the pointer keeps its
      // place on the screen, and the view starts whole again.
      const pointer = this.pointer();
      if (pointer) this.pointer.set({ x: (pointer.x * next.w) / frame.w, y: (pointer.y * next.h) / frame.h });
      this.view.set(WHOLE);
    }
    this.frame.set(next);
  }

  /** How far the picture may be zoomed (twice actual size). */
  zoomLimit(pixelRatio: number): number {
    const frame = this.frame();
    return frame ? maxZoom(this.stage(), frame, pixelRatio) : 1;
  }

  /** Where the trackpad pointer is shown on the stage: always somewhere the page shows (see keepShown). */
  pointerShown(): Point | null {
    const frame = this.frame();
    const stage = this.stage();
    if (!this.trackpad() || !frame || !stage.w || !stage.h) return null;
    const view = this.view();
    const box = boxFor(stage, frame, view);
    const at = keepShown(stage, frame, view, this.pointer() ?? { x: frame.w / 2, y: frame.h / 2 }, POINTER_MARGIN);
    return { x: box.left + (at.x * box.width) / frame.w, y: box.top + (at.y * box.height) / frame.h };
  }

  /** The header's button: as sharp as it gets, around the middle; or back to the whole screen. */
  toggleZoom(pixelRatio: number): void {
    const frame = this.frame();
    if (!frame) return;
    const stage = this.stage();
    if (this.view().zoom > 1.01) {
      this.view.set(WHOLE);
      return;
    }
    // A screen small enough to be sharp already still gets closer. Around the trackpad pointer, when there is one.
    const sharp = Math.max(actualZoom(stage, frame, pixelRatio), 2);
    this.view.set(
      zoomAround(stage, frame, this.view(), this.pointerShown() ?? { x: stage.w / 2, y: stage.h / 2 }, sharp, this.zoomLimit(pixelRatio)),
    );
  }

  /** Where a touch on the stage lands on the Mac's screen, in the Mac's pixels (null with no picture). */
  toFrame(at: Point): Point | null {
    const frame = this.frame();
    const stage = this.stage();
    if (!frame || !stage.w || !stage.h) return null;
    const box = boxFor(stage, frame, this.view());
    if (!box.width || !box.height) return null;
    return {
      x: clamp(((at.x - box.left) / box.width) * frame.w, 0, frame.w - 1),
      y: clamp(((at.y - box.top) / box.height) * frame.h, 0, frame.h - 1),
    };
  }

  toggleTrackpad(): void {
    for (const reset of this.resetters) reset();
    this.trackpad.set(!this.trackpad());
    saveTrackpadMode(this.trackpad());
    this.showTip(this.trackpad() ? this.words.trackpadHint : null);
  }

  showTip(text: string | null): void {
    if (this.#tipTimer) clearTimeout(this.#tipTimer);
    this.tip.set(text);
    this.#tipTimer = text
      ? setTimeout(() => {
          this.tip.set(null);
          this.#tipTimer = null;
        }, 6000)
      : null;
  }

  /** The Mac takes the request when the session starts: a connection under way starts again. */
  toggleSmooth(): void {
    this.smooth.set(!this.smooth());
    saveScreenFlag("smooth", this.smooth());
    const phase = this.phase();
    if (phase === "live" || phase === "connecting" || phase === "signin") void this.start();
  }

  #smoothText(answer: SmoothResult | null): string {
    const words = this.words;
    if (!answer) return words.smoothUnsupported;
    if (answer.applied) return words.smoothApplied(`${answer.width}×${answer.height}`);
    return answer.reason === "already_low" ? words.smoothAlreadyLow : words.smoothFailed;
  }

  /** The form's submit: to the Mac as the answer it asked for, or a fresh connection after a refusal. */
  signIn(): void {
    const credentials = { ...(this.needsUsername() ? { username: this.username() } : {}), password: this.password() };
    this.#remembered = credentials;
    if (!this.keepSignIn()) void this.options.remember?.forget();
    const session = this.#session;
    if (session && !this.refused()) {
      this.phase.set("connecting");
      this.#awaitAnswer(session);
      session.credentials(credentials.username ?? "", credentials.password);
      return;
    }
    void this.start();
  }

  /** The header's Disconnect. */
  disconnect(): void {
    this.#attempt++;
    this.teardown();
    this.phase.set("ended");
  }

  /** The app left the screen: a connection under way is let go, and comes back with it. */
  setBackground(background: boolean): void {
    const phase = this.phase();
    if (background) {
      if (phase === "live" || phase === "connecting" || phase === "signin") {
        this.#attempt++;
        this.teardown();
        this.phase.set("paused");
      }
    } else if (phase === "paused") {
      void this.start();
    }
  }

  takeArmed(): Modifier[] {
    const held = this.armed();
    this.armed.set([]);
    return held;
  }

  toggleModifier(id: Modifier): void {
    this.armed.set(this.armed().includes(id) ? this.armed().filter((m) => m !== id) : [...this.armed(), id]);
  }

  send(keysym: number, down: boolean): void {
    this.#session?.key(keysym, down);
  }

  ctrlAltDel(): void {
    this.#session?.ctrlAltDel();
  }
}
