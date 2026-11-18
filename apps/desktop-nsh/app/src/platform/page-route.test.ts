import { expect, test } from "nsh/test";
import type { UrlOverlay } from "../m/session-url.ts";
import { FLOOR, PageRoute, viewOf, type AddressMove, type BackChain, type Cell, type PageHistory, type RouteRuntime } from "./page-route";

const ORIGIN = "https://relay.example.com";
const A = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const B = "01ARZ3NDEKTSV4RRFFQ69G5FAW";

/**
 * The page's history as NSH keeps it (measured, see `page-route.ts`): `setUrl` writes the current
 * entry or a new one after it, the page's own `back()` and the person's Back both come back as a
 * `change` a turn later (`flush`), with the address of the entry landed on.
 */
function fakePage(start = `${ORIGIN}/`, navigation = "navigate") {
  const entries = [start];
  let index = 0;
  const later: Array<() => void> = [];
  let listener: ((url: string, move: AddressMove) => void) | null = null;
  const page: PageHistory & { entries: string[]; at(): number; go(delta: number): void; flush(): void; press(): void; forward(): void; reload(): void } = {
    entries,
    at: () => index,
    href: () => entries[index]!,
    navigation: () => navigation,
    setUrl(url, history) {
      if (history === "push") {
        entries.length = index + 1;
        entries.push(url);
        index += 1;
      } else entries[index] = url;
    },
    back() {
      if (index === 0) {
        entries.length = 0; // left the page
        return;
      }
      index -= 1;
      later.push(() => listener?.(entries[index]!, "back"));
    },
    whenAt(_hash, then) {
      later.push(then);
    },
    onAddress(next) {
      listener = next;
      return () => (listener = null);
    },
    /** NSH's own `history.go`: its pop is ignored, so the app hears nothing. */
    go(delta) {
      index += delta;
    },
    flush() {
      while (later.length) later.shift()!();
    },
    press() {
      page.back();
      page.flush();
    },
    forward() {
      index += 1;
      listener?.(entries[index]!, "forward");
    },
    reload() {
      navigation = "reload";
    },
  };
  return page;
}

function fakeRuntime(): RouteRuntime & { selected: string[] } {
  const rt = {
    selected: [] as string[],
    selectedId: null as string | null,
    previewRelpath: null as string | null,
    previewAttachmentId: null as string | null,
    settingsOpen: false,
    sessionSettingsOpen: false,
    profileBotId: null as string | null,
    workspaceOpen: false,
    workspaceSelected: null as string | null,
    traceOpen: false,
    traceTaskId: null as string | null,
    routinesOpen: false,
    spendOpen: false,
    terminalOpen: false,
    screenOpen: false,
    listPage: null as "usage" | "archived" | "roles" | null,
    connection: "connected",
    snapshot: { sessions: [{ id: A }, { id: B }], bots: [], settings: { workspace_path: "/w" } },
    applyOverlay(overlay: UrlOverlay) {
      rt.settingsOpen = overlay.kind === "settings";
      rt.sessionSettingsOpen = overlay.kind === "session" || overlay.kind === "bot";
      rt.profileBotId = overlay.kind === "bot" ? overlay.botId : null;
      rt.traceOpen = overlay.kind === "trace";
      rt.listPage = overlay.kind === "usage" || overlay.kind === "archived" || overlay.kind === "roles" ? overlay.kind : null;
    },
    async selectSession(id: string) {
      rt.selected.push(id);
      rt.selectedId = id;
    },
  };
  return rt;
}

function cell(value: string): Cell<string> {
  const read = (() => value) as Cell<string>;
  read.set = (next) => (value = next);
  return read;
}

/** A route with no effects: each step below runs what the effects would, in their order. */
function setup(start = `${ORIGIN}/`, navigation = "navigate", chain: Partial<BackChain> = {}) {
  const page = fakePage(start, navigation);
  const rt = fakeRuntime();
  const back: BackChain = { backMobileLayer: () => false, backFromFloor: () => false, ...chain };
  const route = new PageRoute(page, rt, cell(start), () => back);
  route.seed();
  route.armFloor();
  page.flush();
  page.onAddress((url, move) => {
    route.moved(url, move);
    const now = route.url();
    route.applySession(now);
    route.applyAttachment(now);
    route.applyOverlay(now);
  });
  const write = () => route.write(viewOf(rt));
  return { page, rt, route, write };
}

const path = (url: string) => url.replace(ORIGIN, "");

test("the first entry gets a floor under it, unless a reload kept the first load's", () => {
  const { page } = setup();
  expect(page.entries.map(path)).toEqual([`/${FLOOR}`, "/"]);
  expect(page.at()).toBe(1);
  const reloaded = setup(`${ORIGIN}/?s=${A}`, "reload");
  expect(reloaded.page.entries.map(path)).toEqual([`/?s=${A}`]);
});

test("a conversation opened pushes its address, and closing it walks back to the roster's entry", () => {
  const { page, rt, route, write } = setup();
  rt.selectedId = A;
  write();
  expect(page.entries.map(path)).toEqual([`/${FLOOR}`, "/", `/?s=${A}`]);
  // The phone's own Back (top-back): the entry under it is the roster's, so history goes back to it.
  rt.selectedId = null;
  write();
  page.flush();
  expect(page.at()).toBe(1);
  expect(path(route.address())).toBe("/");
  expect(route.stack).toEqual([""]);
  expect(rt.selectedId).toBe(null);
});

test("the browser's Back off a conversation closes it, and its Forward opens it again", () => {
  const { page, rt, write } = setup();
  rt.selectedId = A;
  write();
  page.press();
  expect(rt.selectedId).toBe(null);
  write();
  expect(page.entries.length).toBe(3); // nothing written: the address is the roster's already
  page.forward();
  expect(rt.selected).toEqual([A]);
});

test("Back closes a layer the address does not carry first, and the conversation's entry goes up again", () => {
  let searchOpen = true;
  const { page, rt, write } = setup(`${ORIGIN}/`, "navigate", { backMobileLayer: () => (searchOpen ? ((searchOpen = false), true) : false) });
  rt.selectedId = A;
  write();
  page.press();
  expect(rt.selectedId).toBe(A);
  expect(path(page.href())).toBe(`/?s=${A}`);
  // The next Back is the conversation's.
  page.press();
  expect(rt.selectedId).toBe(null);
});

test("a Back settings took as a step keeps its address on the entry NSH gave back, adding none", () => {
  let ctx: ReturnType<typeof setup>;
  ctx = setup(`${ORIGIN}/`, "navigate", { backMobileLayer: () => ctx.rt.settingsOpen });
  const { page, rt, route, write } = ctx;
  rt.settingsOpen = true;
  write();
  expect(page.entries.map(path)).toEqual([`/${FLOOR}`, "/", "/?o=settings"]);
  // The browser's Back reaches the dialog first: it steps out of a tab's page and stays, and NSH
  // pushes its entry again, at the address under it, before the `change` comes.
  page.back();
  page.setUrl(page.href(), "push");
  page.flush();
  expect(rt.settingsOpen).toBe(true);
  expect(page.entries.map(path)).toEqual([`/${FLOOR}`, "/", "/?o=settings"]);
  expect(page.at()).toBe(2);
  expect(path(route.address())).toBe("/?o=settings");
  // Off the list of tabs the dialog closes itself: the Back lands on the roster's entry.
  rt.settingsOpen = false;
  page.press();
  expect(path(route.address())).toBe("/");
  expect(page.at()).toBe(1);
});

test("settings closed by the app (✕, the bottom bar) leaves the going back to NSH, and the address lands where it goes", () => {
  const { page, rt, route, write } = setup();
  rt.settingsOpen = true;
  write();
  expect(page.entries.map(path)).toEqual([`/${FLOOR}`, "/", "/?o=settings"]);
  rt.settingsOpen = false;
  write();
  // NSH takes the dialog's entry away (a `history.go(-1)` whose pop it ignores) and puts the
  // address the app set meanwhile on the entry it lands on.
  const waiting = page.href();
  page.entries[page.at()] = `${ORIGIN}/?o=settings`;
  page.entries[page.at() - 1] = waiting;
  page.go(-1);
  expect(page.at()).toBe(1);
  expect(path(page.href())).toBe("/");
  expect(route.stack).toEqual([""]);
  expect(path(route.address())).toBe("/");
  // Nothing of ours is left waiting: a conversation opened and Back off it walk as ever.
  rt.selectedId = A;
  write();
  expect(page.entries.map(path)).toEqual([`/${FLOOR}`, "/", `/?s=${A}`]);
  page.press();
  expect(rt.selectedId).toBe(null);
  expect(path(route.address())).toBe("/");
});

test("a group's settings, a Bot opened from them, then the Bot's closed by the app: the address lands on the conversation", () => {
  const { page, rt, route, write } = setup();
  rt.selectedId = A;
  write();
  rt.sessionSettingsOpen = true;
  write();
  const groupAt = path(page.href());
  // The Bot takes the group settings' place (a swap): one dialog entry still.
  rt.profileBotId = B;
  write();
  expect(page.entries.length).toBe(4);
  expect(path(page.href())).not.toBe(groupAt);
  rt.sessionSettingsOpen = false;
  rt.profileBotId = null;
  write();
  const waiting = page.href();
  page.entries[page.at() - 1] = waiting;
  page.go(-1);
  expect(path(page.href())).toBe(`/?s=${A}`);
  expect(route.stack).toEqual(["", `?s=${A}`]);
  // Back off the conversation is the roster's, as ever.
  page.press();
  expect(rt.selectedId).toBe(null);
  expect(path(route.address())).toBe("/");
});

test("Back on the floor closes the screen showing and goes up again; with nothing open it leaves the page", () => {
  const rt0 = { closed: 0 };
  let ctx: ReturnType<typeof setup>;
  ctx = setup(`${ORIGIN}/?s=${A}`, "navigate", {
    backFromFloor: () => {
      if (!ctx.rt.selectedId) return false;
      ctx.rt.selectedId = null;
      rt0.closed += 1;
      return true;
    },
  });
  const { page, rt } = ctx;
  expect(rt.selectedId).toBe(A); // seeded from the link
  expect(page.entries.map(path)).toEqual([`/?s=${A}${FLOOR}`, `/?s=${A}`]);
  page.press(); // onto the floor
  expect(rt0.closed).toBe(1);
  expect(page.entries.map(path)).toEqual([`/?s=${A}${FLOOR}`, "/"]);
  expect(page.at()).toBe(1);
  page.press(); // the floor again, nothing left: out of the page
  expect(page.entries.length).toBe(0);
});

test("a link to a conversation with nothing of ours under it rewrites its entry when the conversation closes", () => {
  const { page, rt, write } = setup(`${ORIGIN}/?s=${A}`, "reload");
  rt.selectedId = null;
  write();
  expect(page.entries.map(path)).toEqual(["/"]);
});

test("another conversation pushes, so Back retraces where you have been", () => {
  const { page, rt, write } = setup();
  rt.selectedId = A;
  write();
  rt.selectedId = B;
  write();
  expect(page.entries.map(path).slice(-2)).toEqual([`/?s=${A}`, `/?s=${B}`]);
  page.press();
  expect(rt.selected).toEqual([A]);
});

test("settings closed by the browser's Back moves only our books: no second step back out of the page", () => {
  const { page, rt, route, write } = setup();
  rt.applyOverlay({ kind: "settings" });
  write();
  expect(path(page.href())).toBe("/?o=settings");
  // NSH's modal took the Back: the page is at the roster before the settings' close is heard.
  page.back();
  rt.applyOverlay({ kind: "none" });
  write();
  page.flush();
  expect(page.at()).toBe(1);
  expect(path(route.address())).toBe("/");
  expect(page.entries.length).toBe(3);
});

test("an earlier load's entry handed over after a reload opens what it names", () => {
  const { rt, route } = setup(`${ORIGIN}/`, "reload");
  route.moved(`${ORIGIN}/?s=${B}`, "open");
  route.applySession(route.url());
  expect(rt.selected).toEqual([B]);
  expect(route.stack).toEqual([`?s=${B}`]);
});

test("a page over the roster has an address of its own", () => {
  const { page, rt, write } = setup();
  rt.applyOverlay({ kind: "usage" });
  write();
  expect(path(page.href())).toBe("/?o=usage");
  page.press();
  expect(rt.listPage).toBe(null);
});
