/**
 * Banners where the shell posts none: on Windows and Linux NSH shows notifications itself (its
 * `Notifications`: toasts on Windows, under the app's AppUserModelID that `run_app` registers; the
 * desktop's notification service on Linux), so the macOS shell's delivery loop
 * (`host/src/notification_loop.rs`) runs here, in the app, against the same routes. Every two
 * seconds: the attention count goes on the badge (the taskbar button on Windows) as the device's
 * preference says; when the cleanup revision moves, banners the runtime no longer wants are
 * closed; and one notification is claimed, revalidated, shown and reported.
 *
 * The messenger asks the shell about notifications by shell commands; on these desktops the app
 * answers four of them (`BANNER_COMMANDS`, through `shell-bridge.ts`): the permission is NSH's, a
 * pressed banner's click reference is the intent `take_notification_intent` hands over, and
 * `report_notification_view` also tells the runtime which conversation is in front of you, which
 * the macOS shell's presence queue does there.
 *
 * A banner's NSH id carries the runtime's identifier and the click reference (`toastId`): a newer
 * banner for the same conversation closes the one before it, as the identifier replaces it on
 * macOS, and a press, even one that starts the app anew, hands back what to open.
 */
import { host, Notifications, platform, type NotificationPermission, type NotificationsModule, type OS } from "nsh";

/** The desktops where the app shows the banners: the shell has no notification loop of its own. */
export function appShowsBanners(os: OS = platform.os): boolean {
  return os === "windows" || os === "linux";
}

export const POLL_MS = 2_000;

/** The runtime's address and token, read again on every pass: a runtime that started again has a new token. */
export type Endpoint = { origin: string; token: string };
type Fetch = (url: string, init: { method: string; headers: Record<string, string>; body?: string }) => Promise<{
  status: number;
  ok: boolean;
  json(): Promise<unknown>;
}>;
type Banners = Pick<NotificationsModule, "permission" | "requestPermission" | "show" | "close" | "setBadge" | "on">;

export type BannerDeps = {
  notifications: Banners;
  endpoint: () => Promise<Endpoint>;
  fetch: Fetch;
};

type Claim = {
  delivery_id: string;
  claim_token: string;
  click_ref: string;
  title: string;
  body: string;
  sound?: string | null;
  identifier: string;
};
type Revalidated = { action: string; title?: string | null; body?: string | null; sound?: string | null };

/** The NSH id of a banner: the runtime's identifier, then the click reference a press hands back. */
export function toastId(identifier: string, clickRef: string): string {
  return `${identifier}|${clickRef}`;
}

/** The click reference in a pressed banner's id, or null for one that is not the loop's. */
export function clickRefOf(id: string): string | null {
  const at = id.indexOf("|");
  return at < 0 ? null : id.slice(at + 1) || null;
}

/** What the badge shows for `count`: nothing at 0, or when the device's preference turns it off. */
export function badgeCount(count: number, preference: { enabled: boolean; badge: boolean }): number {
  return preference.enabled && preference.badge ? Math.max(0, Math.trunc(count)) : 0;
}

/** How long the permission may take to answer before it counts as `unavailable`: the messenger's
 * state poll waits on it, and a poll that never ended would leave every conversation unread. */
export const PERMISSION_WAIT_MS = 5_000;

/** `promise`, or `fallback` once `ms` have gone by or it fails. */
export function within<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(fallback), ms);
    promise.then(
      (value) => (clearTimeout(timer), resolve(value)),
      () => (clearTimeout(timer), resolve(fallback)),
    );
  });
}

function randomHex(): string {
  const bytes = new Uint8Array(16);
  globalThis.crypto?.getRandomValues?.(bytes);
  if (bytes.every((b) => b === 0)) return `${Date.now().toString(16)}${Math.random().toString(16).slice(2)}`;
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export class AppBanners {
  permission: NotificationPermission = "unavailable";
  attentionCount = 0;
  private intent: string | null = null;
  /** The banners this run showed: the runtime's identifier → the NSH id. */
  private readonly shown = new Map<string, string>();
  private badge = -1;
  private cleanupRevision = 0;
  private readonly ownerId = randomHex();
  private readonly presenceId = randomHex();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private stopPress: (() => void) | null = null;
  private passing = false;
  private readonly pressListeners = new Set<() => void>();

  constructor(private readonly deps: BannerDeps) {}

  /** Starts the loop and listens for presses, once. */
  start(): void {
    if (this.timer || this.stopPress) return;
    try {
      this.stopPress = this.deps.notifications.on("press", ({ id }) => {
        const ref = clickRefOf(id);
        if (!ref) return;
        this.intent = ref;
        for (const listener of this.pressListeners) listener();
      });
    } catch {
      // No `notifications` capability: nothing to show, nothing pressed.
      return;
    }
    const tick = async () => {
      await this.pass().catch(() => undefined);
      this.timer = setTimeout(tick, POLL_MS);
    };
    this.timer = setTimeout(tick, 0);
  }

  /** Hears a press as it comes (the intent is then there to take); returns how to stop hearing it. */
  onPressed(listener: () => void): () => void {
    this.pressListeners.add(listener);
    return () => this.pressListeners.delete(listener);
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.stopPress?.();
    this.stopPress = null;
  }

  /** `notification_permission_state`'s answer (`NotificationPermissionStateDto`). */
  async permissionState(): Promise<Record<string, unknown>> {
    this.permission = await within(this.deps.notifications.permission(), PERMISSION_WAIT_MS, "unavailable");
    return this.dto();
  }

  /** `request_notification_permission`'s: Windows asks nothing (a toast shows unless turned off in Settings). */
  async requestPermission(): Promise<Record<string, unknown>> {
    this.permission = await within(this.deps.notifications.requestPermission(), 60_000, "unavailable");
    return this.dto();
  }

  /** `take_notification_intent`'s: the pressed banner's click reference, once. */
  takeIntent(): { clickRef: string } | null {
    const ref = this.intent;
    this.intent = null;
    return ref ? { clickRef: ref } : null;
  }

  /** Tells the runtime where the reader is (`report_notification_view`), as the macOS shell's presence queue does. */
  async reportPresence(report: { sessionId?: string | null; atLatest?: boolean; visible?: boolean; focused?: boolean }, window: number): Promise<void> {
    const visible = report.visible ?? true;
    await this.post("/v1/notification-presence", {
      instance_id: `${this.presenceId}-w${window}`,
      visible,
      focused: visible && Boolean(report.focused),
      ...(report.sessionId ? { session_id: report.sessionId } : {}),
      at_latest: Boolean(report.atLatest),
    }).catch(() => undefined);
  }

  private dto(): Record<string, unknown> {
    const operational = this.permission !== "unavailable";
    return {
      permission: operational ? this.permission : "default",
      nativeReadingV1: true,
      nativeDeliveryV1: operational,
      coldClickQualified: false,
      operational,
      gatedReason: operational ? null : "native_delivery_unavailable",
      attentionCount: this.attentionCount,
    };
  }

  private async request(method: string, path: string, body?: unknown) {
    const { origin, token } = await this.deps.endpoint();
    const headers: Record<string, string> = { Authorization: `Bearer ${token}`, Accept: "application/json" };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    return this.deps.fetch(`${origin}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  }

  private async get<T>(path: string): Promise<T> {
    const res = await this.request("GET", path);
    if (!res.ok) throw new Error(`${path}: ${res.status}`);
    return (await res.json()) as T;
  }

  private async post<T>(path: string, body: unknown): Promise<T | null> {
    const res = await this.request("POST", path, body);
    if (res.status === 204) return null;
    if (!res.ok) throw new Error(`${path}: ${res.status}`);
    return (await res.json().catch(() => null)) as T | null;
  }

  /** One pass, as `notification_loop.rs` `poll_cycle`. */
  async pass(): Promise<void> {
    if (this.passing) return;
    this.passing = true;
    try {
      await this.passOnce();
    } finally {
      this.passing = false;
    }
  }

  private async passOnce(): Promise<void> {
    const banners = this.deps.notifications;
    this.permission = await within(banners.permission(), PERMISSION_WAIT_MS, "unavailable");
    if (this.permission === "unavailable") return;

    const state = await this.get<{ attention_count?: number; cleanup_revision?: number }>("/v1/notifications/desktop/state").catch(() => null);
    if (state) {
      this.attentionCount = state.attention_count ?? 0;
      const preference = await this.get<{ enabled: boolean; badge: boolean }>("/v1/notification-device").catch(() => ({ enabled: true, badge: true }));
      const badge = badgeCount(this.attentionCount, preference);
      if (badge !== this.badge && (await banners.setBadge(badge).then(() => true, () => false))) this.badge = badge;

      const revision = state.cleanup_revision ?? 0;
      if (revision !== this.cleanupRevision) {
        if (await this.reconcile()) this.cleanupRevision = revision;
      }
    }

    const claim = await this.post<Claim>("/v1/notifications/desktop/claim", { owner_id: this.ownerId, permission: this.permission });
    if (!claim) return;
    const report = (result: string, code?: string) =>
      this.post("/v1/notifications/desktop/report", { delivery_id: claim.delivery_id, claim_token: claim.claim_token, result, ...(code ? { code } : {}) }).catch(() => undefined);
    let revalidated: Revalidated | null;
    try {
      revalidated = await this.post<Revalidated>("/v1/notifications/desktop/revalidate", { delivery_id: claim.delivery_id, claim_token: claim.claim_token });
    } catch (error) {
      await report("unknown", String((error as Error).message ?? error));
      return;
    }
    const action = revalidated?.action ?? "";
    if (action === "retry_later") return;
    if (action === "cancel") return void (await report("failed", "cancelled"));
    if (action !== "deliver") return void (await report("unknown", "unknown_action"));

    const sound = revalidated?.sound ?? claim.sound ?? "default";
    const id = toastId(claim.identifier, claim.click_ref);
    const before = this.shown.get(claim.identifier);
    if (before && before !== id) await banners.close(before).catch(() => undefined);
    const shown = await banners
      .show({ id, title: revalidated?.title ?? claim.title, body: revalidated?.body ?? claim.body, silent: sound === "off" })
      .catch(() => false);
    if (!shown) return void (await report("failed", "delivery_gated"));
    this.shown.set(claim.identifier, id);
    await report("accepted");
  }

  /** Closes the banners the runtime no longer wants; true once every identifier was asked about. */
  private async reconcile(): Promise<boolean> {
    const identifiers = [...this.shown.keys()];
    for (let at = 0; at < identifiers.length; at += 100) {
      const answer = await this.post<{ remove_identifiers?: string[] }>("/v1/notifications/desktop/reconcile", { identifiers: identifiers.slice(at, at + 100) }).catch(() => undefined);
      if (answer === undefined) return false;
      for (const identifier of answer?.remove_identifiers ?? []) {
        const id = this.shown.get(identifier);
        if (id) await this.deps.notifications.close(id).catch(() => undefined);
        this.shown.delete(identifier);
      }
    }
    return true;
  }
}

/** The runtime this window talks to, from the shell (`launch.rs` `runtime.endpoint`). */
async function shellEndpoint(): Promise<Endpoint> {
  return (await host.call("runtime.endpoint", null)) as Endpoint;
}

let banners: AppBanners | null = null;

/** The process's loop on a desktop whose shell posts no banners; null elsewhere. Made, not started. */
export function appBanners(): AppBanners | null {
  if (!appShowsBanners() || !host.available()) return null;
  banners ??= new AppBanners({ notifications: Notifications, endpoint: shellEndpoint, fetch: (url, init) => fetch(url, init) });
  return banners;
}

/** The shell commands the app answers on these desktops; `shell` asks the shell. */
export function bannerCommands(
  loop: AppBanners,
  shell: (command: string, args: Record<string, unknown>) => Promise<unknown>,
  window: () => number,
): Record<string, (args: Record<string, unknown>) => Promise<unknown>> {
  return {
    notification_permission_state: () => loop.permissionState(),
    request_notification_permission: () => loop.requestPermission(),
    take_notification_intent: async () => loop.takeIntent(),
    report_notification_view: async (args) => {
      const report = (args.report ?? {}) as { sessionId?: string | null; atLatest?: boolean; visible?: boolean; focused?: boolean };
      const facts = (await shell("report_notification_view", args)) as { visible?: boolean; effectiveFocused?: boolean } | null;
      await loop.reportPresence({ ...report, visible: facts?.visible ?? report.visible, focused: facts?.effectiveFocused ?? report.focused }, window());
      return facts;
    },
  };
}
