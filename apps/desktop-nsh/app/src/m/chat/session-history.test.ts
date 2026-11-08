/** A conversation read in this connection is not read again when it is selected again. */
import { USER_MEMBER } from "@real-bot/protocol";
import { expect, test } from "nsh/test";
import { emptySnapshot } from "../snapshot.ts";
import { SessionView } from "../session-view.svelte.ts";
import { SessionHistory, type SessionHistoryHost } from "./session-history.svelte.ts";

function setup() {
  const views = new Map<string, SessionView>();
  const reads: string[] = [];
  const session = (id: string) => ({ id, kind: "direct", name: id, created_at: "2026-11-09T00:00:00Z", updated_at: "2026-11-09T00:00:00Z", participants: [{ member: USER_MEMBER, left_at: null }, { member: "bot-1", left_at: null }], unread_count: 0 });
  const host = {
    api: {
      sessionSnapshot: async (id: string) => {
        reads.push(id);
        return {
          session: { ...session(id), messages: { items: [{ id: `m-${id}`, session_id: id, kind: "user", author: "you", body: "hi", created_at: "2026-11-09T00:00:01Z" }], next: null }, turns: [] },
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
