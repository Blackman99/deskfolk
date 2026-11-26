/** A conversation read in this connection is not read again when it is selected again. */
import { USER_MEMBER } from "@real-bot/protocol";
import { expect, test } from "nsh/test";
import { emptySnapshot } from "../snapshot.ts";
import { SessionView } from "../session-view.svelte.ts";
import { SessionHistory, type SessionHistoryHost } from "./session-history.svelte.ts";

type Page = { items: Array<Record<string, unknown>>; next: string | null };

function setup(page?: (id: string) => Page) {
  const views = new Map<string, SessionView>();
  const reads: string[] = [];
  const session = (id: string) => ({ id, kind: "direct", name: id, created_at: "2026-11-09T00:00:00Z", updated_at: "2026-11-09T00:00:00Z", participants: [{ member: USER_MEMBER, left_at: null }, { member: "bot-1", left_at: null }], unread_count: 0 });
  const host = {
    api: {
      sessionSnapshot: async (id: string) => {
        reads.push(id);
        return {
          session: { ...session(id), messages: page?.(id) ?? { items: [{ id: `m-${id}`, session_id: id, kind: "user", author: "you", body: "hi", created_at: "2026-11-09T00:00:01Z" }], next: null }, turns: [] },
          judgements: [],
          event_instance_id: "e1",
          watermark_seq: 0,
        };
      },
    },
    sync: { pause() {}, waitThrough: async () => true, install: () => [] },
    connectionSeq: 1,
    snapshot: { ...emptySnapshot(), sessions: [session("a"), session("b")] },
    selectedId: null as string | null,
    get activeView() {
      return this.selectedId ? this.sessionView(this.selectedId) : null;
    },
    focusedTurnId: null,
    get historyLoading() {
      return this.activeView?.historyLoading ?? false;
    },
    set historyLoading(value: boolean) {
      if (this.activeView) this.activeView.historyLoading = value;
    },
    notificationCapabilities: { bounded_read_v1: true },
    spendOpen: false,
    terminalOpen: false,
    traceOpen: false,
    traceSessionId: null,
    threadOpen: false,
    sessionView(id: string) {
      let view = views.get(id);
      if (!view) views.set(id, (view = new SessionView(id)));
      return view;
    },
    selectSession: async () => {},
    markSessionRead: async () => {},
    setHighlightedMessage() {},
    ingest() {},
    loadAnnotations: async () => {},
    markDisconnected() {},
    toPane: () => false,
    closeRoutines() {},
    closeSpend() {},
    closeTerminal() {},
    closeRemoteScreen() {},
    closeListPage() {},
    closeGit() {},
    closeSessionSettings() {},
    openSpend() {},
    openTerminal() {},
  };
  return { host, reads, history: new SessionHistory(host as unknown as SessionHistoryHost) };
}

test("selecting again within a connection reads nothing; a new connection reads again", async () => {
  const { host, reads, history } = setup();
  await history.selectSession("a");
  await history.selectSession("b");
  expect(reads).toEqual(["a", "b"]);
  await history.selectSession("a");
  expect(reads).toEqual(["a", "b"]);
  expect(host.selectedId).toBe("a");
  expect(host.sessionView("a").detailLoaded).toBe(true);
  expect(host.sessionView("a").historyLoading).toBe(false);
  host.connectionSeq = 2;
  await history.selectSession("b");
  expect(reads).toEqual(["a", "b", "b"]);
});

const line = (n: number) => ({ id: `m${n}`, session_id: "a", kind: "user", author: "you", body: `line ${n}`, created_at: `2026-11-09T00:0${n}:00Z` });
const held = (host: ReturnType<typeof setup>["host"]) => host.snapshot.messages.map((m: { id: string }) => m.id).sort();

test("a first page read again keeps the older lines it reaches back into, and pages on from their cursor", async () => {
  const { host, history } = setup(() => ({ items: [line(7), line(6), line(5)], next: "c5" }));
  host.snapshot = { ...host.snapshot, messages: [2, 3, 4, 5, 6, 7].map(line) as never };
  host.sessionView("a").kept = { next: "c2", newest: line(6) };
  await history.selectSession("a");
  expect(held(host)).toEqual(["m2", "m3", "m4", "m5", "m6", "m7"]);
  expect(host.sessionView("a").messageNext).toBe("c2");
  expect(host.sessionView("a").kept).toBe(undefined);
});

test("a line the link's snapshot brought is no part of what was read: a page down to it replaces the rest", async () => {
  // A page of one very long line, the roster's newest: the lines held stop at m6, and m7 and m8 came meanwhile.
  const { host, history } = setup(() => ({ items: [line(9)], next: "c9" }));
  host.snapshot = { ...host.snapshot, messages: [2, 3, 4, 5, 6, 9].map(line) as never };
  host.sessionView("a").kept = { next: "c2", newest: line(6) };
  await history.selectSession("a");
  expect(held(host)).toEqual(["m9"]);
  expect(host.sessionView("a").messageNext).toBe("c9");
});

test("a page that is the whole history drops held lines it lacks", async () => {
  const { host, history } = setup(() => ({ items: [line(7), line(6)], next: null }));
  host.snapshot = { ...host.snapshot, messages: [4, 5, 6, 7].map(line) as never };
  host.sessionView("a").kept = { next: "c4", newest: line(7) };
  await history.selectSession("a");
  expect(held(host)).toEqual(["m6", "m7"]);
  expect(host.sessionView("a").messageNext).toBe(null);
});

test("a conversation not read yet takes its first page as the history, whatever came by events", async () => {
  // Its last line and what arrived since: nothing paged behind them, so no cursor of theirs to keep.
  const { host, history } = setup(() => ({ items: [line(7), line(6)], next: "c6" }));
  host.snapshot = { ...host.snapshot, messages: [5, 6, 7].map(line) as never };
  await history.selectSession("a");
  expect(held(host)).toEqual(["m6", "m7"]);
  expect(host.sessionView("a").messageNext).toBe("c6");
});

test("a link to a line reads the first page again in the same connection and keeps what was paged back", async () => {
  const { host, history } = setup(() => ({ items: [line(7), line(6), line(5)], next: "c5" }));
  await history.selectSession("a");
  // Paged back since, as scrolling to the top does: older lines and the cursor past them.
  host.snapshot = { ...host.snapshot, messages: [...host.snapshot.messages, ...[2, 3, 4].map(line)] as never };
  host.sessionView("a").messageNext = "c2";
  await history.selectSession("a", { messageId: "m3" });
  expect(held(host)).toEqual(["m2", "m3", "m4", "m5", "m6", "m7"]);
  expect(host.sessionView("a").messageNext).toBe("c2");
});
