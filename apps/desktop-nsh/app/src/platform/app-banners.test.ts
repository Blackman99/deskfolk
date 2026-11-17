import { expect, test } from "nsh/test";
import type { NotificationPermission } from "nsh";
import { AppBanners, appShowsBanners, badgeCount, bannerCommands, clickRefOf, toastId, within, type BannerDeps } from "./app-banners";

type Call = { method: string; path: string; body: Record<string, unknown> | null; auth: string };

/** A runtime that answers the desktop routes from `routes`, and NSH's `Notifications` that records. */
function fixture(routes: Record<string, (body: Record<string, unknown> | null) => [number, unknown]>, permission: NotificationPermission = "granted") {
  const calls: Call[] = [];
  const shown: Array<{ id: string; title: string; body?: string | null; silent?: boolean | null }> = [];
  const closed: string[] = [];
  const badges: number[] = [];
  let press: ((p: { id: string }) => void) | null = null;
  const deps: BannerDeps = {
    endpoint: async () => ({ origin: "http://127.0.0.1:17890", token: "t1" }),
    fetch: async (url, init) => {
      const path = url.replace("http://127.0.0.1:17890", "");
      const body = init.body ? (JSON.parse(init.body) as Record<string, unknown>) : null;
      calls.push({ method: init.method, path, body, auth: init.headers.Authorization ?? "" });
      const [status, answer] = routes[`${init.method} ${path}`]?.(body) ?? [404, {}];
      return { status, ok: status >= 200 && status < 300, json: async () => answer };
    },
    notifications: {
      permission: async () => permission,
      requestPermission: async () => permission,
      show: async (options) => (shown.push(options), permission === "granted"),
      close: async (id) => void closed.push(id),
      setBadge: async (count) => void badges.push(count),
      on: (_event, listener) => ((press = listener), () => (press = null)),
    },
  };
  return { deps, calls, shown, closed, badges, press: (id: string) => press?.({ id }) };
}

const claim = (identifier: string, clickRef: string) => ({
  delivery_id: `d-${clickRef}`,
  claim_token: `c-${clickRef}`,
  click_ref: clickRef,
  title: "Writer",
  body: "写好了",
  sound: "default",
  identifier,
});

test("the app shows the banners on Windows and Linux only; the macOS shell has its own loop", () => {
  expect(appShowsBanners("windows")).toBe(true);
  expect(appShowsBanners("linux")).toBe(true);
  expect(appShowsBanners("macos")).toBe(false);
  expect(appShowsBanners("web")).toBe(false);
  expect(clickRefOf(toastId("session:01J", "ref-1"))).toBe("ref-1");
  expect(clickRefOf("someone else's")).toBe(null);
  expect(badgeCount(3, { enabled: true, badge: true })).toBe(3);
  expect(badgeCount(3, { enabled: true, badge: false })).toBe(0);
});

test("a pass puts the count on the badge, then claims, shows and reports one banner", async () => {
  const claims = [claim("session:01J", "ref-1")];
  const f = fixture({
    "GET /v1/notifications/desktop/state": () => [200, { attention_count: 3, cleanup_revision: 0 }],
    "GET /v1/notification-device": () => [200, { enabled: true, badge: true }],
    "POST /v1/notifications/desktop/claim": () => (claims.length ? [200, claims.shift()] : [204, null]),
    "POST /v1/notifications/desktop/revalidate": () => [200, { action: "deliver", title: "Writer", body: "写好了：周报", sound: "off" }],
    "POST /v1/notifications/desktop/report": () => [200, {}],
  });
  const loop = new AppBanners(f.deps);
  await loop.pass();
  expect(f.badges).toEqual([3]);
  expect(f.shown).toEqual([{ id: "session:01J|ref-1", title: "Writer", body: "写好了：周报", silent: true }]);
  const claimed = f.calls.find((c) => c.path === "/v1/notifications/desktop/claim")!;
  expect(claimed.body).toMatchObject({ permission: "granted" });
  expect(claimed.auth).toBe("Bearer t1");
  expect(f.calls.find((c) => c.path === "/v1/notifications/desktop/report")!.body).toEqual({ delivery_id: "d-ref-1", claim_token: "c-ref-1", result: "accepted" });
  // The same count again: the badge is not set again.
  await loop.pass();
  expect(f.badges).toEqual([3]);
});

test("a newer banner for the same conversation closes the one before it", async () => {
  const claims = [claim("session:01J", "ref-1"), claim("session:01J", "ref-2")];
  const f = fixture({
    "GET /v1/notifications/desktop/state": () => [200, { attention_count: 0, cleanup_revision: 0 }],
    "GET /v1/notification-device": () => [200, { enabled: true, badge: true }],
    "POST /v1/notifications/desktop/claim": () => (claims.length ? [200, claims.shift()] : [204, null]),
    "POST /v1/notifications/desktop/revalidate": () => [200, { action: "deliver" }],
    "POST /v1/notifications/desktop/report": () => [200, {}],
  });
  const loop = new AppBanners(f.deps);
  await loop.pass();
  await loop.pass();
  expect(f.shown.map((s) => s.id)).toEqual(["session:01J|ref-1", "session:01J|ref-2"]);
  expect(f.closed).toEqual(["session:01J|ref-1"]);
});

test("a press leaves its click reference to take once, and says so at once", () => {
  const f = fixture({});
  const loop = new AppBanners(f.deps);
  let heard = 0;
  loop.onPressed(() => heard++);
  loop.start();
  f.press("session:01J|ref-9");
  expect(heard).toBe(1);
  expect(loop.takeIntent()).toEqual({ clickRef: "ref-9" });
  expect(loop.takeIntent()).toBe(null);
  f.press("not the loop's");
  expect(loop.takeIntent()).toBe(null);
  loop.stop();
});

test("when the cleanup revision moves, banners the runtime no longer wants are closed", async () => {
  let revision = 0;
  const claims = [claim("session:A", "ref-a"), claim("host:all", "ref-h")];
  const f = fixture({
    "GET /v1/notifications/desktop/state": () => [200, { attention_count: 0, cleanup_revision: revision }],
    "GET /v1/notification-device": () => [200, { enabled: true, badge: true }],
    "POST /v1/notifications/desktop/claim": () => (claims.length ? [200, claims.shift()] : [204, null]),
    "POST /v1/notifications/desktop/revalidate": () => [200, { action: "deliver" }],
    "POST /v1/notifications/desktop/report": () => [200, {}],
    "POST /v1/notifications/desktop/reconcile": (body) => {
      expect((body!.identifiers as string[]).sort()).toEqual(["host:all", "session:A"]);
      return [200, { remove_identifiers: ["session:A"] }];
    },
  });
  const loop = new AppBanners(f.deps);
  await loop.pass();
  await loop.pass();
  revision = 1;
  await loop.pass();
  expect(f.closed).toEqual(["session:A|ref-a"]);
  expect(f.calls.filter((c) => c.path === "/v1/notifications/desktop/reconcile")).toHaveLength(1);
});

test("a cancelled claim and a banner the system did not take are reported failed", async () => {
  const claims = [claim("session:A", "ref-a"), claim("session:B", "ref-b")];
  let action = "cancel";
  const f = fixture(
    {
      "GET /v1/notifications/desktop/state": () => [200, { attention_count: 0, cleanup_revision: 0 }],
      "GET /v1/notification-device": () => [200, { enabled: true, badge: true }],
      "POST /v1/notifications/desktop/claim": () => (claims.length ? [200, claims.shift()] : [204, null]),
      "POST /v1/notifications/desktop/revalidate": () => [200, { action }],
      "POST /v1/notifications/desktop/report": () => [200, {}],
    },
    "denied",
  );
  const loop = new AppBanners(f.deps);
  await loop.pass();
  action = "deliver";
  await loop.pass();
  const reports = f.calls.filter((c) => c.path === "/v1/notifications/desktop/report").map((c) => c.body);
  expect(reports).toEqual([
    { delivery_id: "d-ref-a", claim_token: "c-ref-a", result: "failed", code: "cancelled" },
    { delivery_id: "d-ref-b", claim_token: "c-ref-b", result: "failed", code: "delivery_gated" },
  ]);
});

test("where NSH shows none, the loop asks the runtime nothing and the messenger sees no delivery", async () => {
  const f = fixture({}, "unavailable");
  const loop = new AppBanners(f.deps);
  await loop.pass();
  expect(f.calls).toEqual([]);
  expect(await loop.permissionState()).toMatchObject({ permission: "default", nativeDeliveryV1: false, nativeReadingV1: true });
  const granted = new AppBanners(fixture({}, "granted").deps);
  expect(await granted.permissionState()).toMatchObject({ permission: "granted", nativeDeliveryV1: true, operational: true });
});

test("report_notification_view asks the shell for the window's facts and tells the runtime where the reader is", async () => {
  const f = fixture({ "POST /v1/notification-presence": () => [200, {}] });
  const loop = new AppBanners(f.deps);
  const shell: Array<[string, unknown]> = [];
  const commands = bannerCommands(
    loop,
    async (command, args) => (shell.push([command, args]), { visible: true, focused: true, minimized: false, effectiveFocused: true }),
    () => 2,
  );
  const facts = await commands.report_notification_view!({ report: { sessionId: "s1", atLatest: true, visible: true, focused: true } });
  expect(facts).toMatchObject({ effectiveFocused: true });
  expect(shell.map(([c]) => c)).toEqual(["report_notification_view"]);
  const presence = f.calls.find((c) => c.path === "/v1/notification-presence")!.body!;
  expect(presence).toMatchObject({ visible: true, focused: true, session_id: "s1", at_latest: true });
  expect(String(presence.instance_id)).toMatch(/-w2$/);
  expect(await commands.take_notification_intent!({})).toBe(null);
});

test("a permission that never answers counts as unavailable, so the messenger's poll still ends", async () => {
  expect(await within(new Promise<string>(() => undefined), 20, "unavailable")).toBe("unavailable");
  expect(await within(Promise.resolve("granted"), 20, "unavailable")).toBe("granted");
  expect(await within(Promise.reject(new Error("no")), 20, "unavailable")).toBe("unavailable");
});
