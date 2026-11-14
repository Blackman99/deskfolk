import { describe, expect, test } from "bun:test";
import type { ClientEvent } from "@real-bot/protocol";
import { Store } from "./index";

describe("what a change of a Bot tells clients is gone", () => {
  test("only the sessions it is in that went out of sight, never every hidden one", () => {
    const store = new Store();
    try {
      const gone = store.createBot({ name: "Gone", duties: "d", boundaries: "b" });
      const writer = store.createBot({ name: "Writer", duties: "d", boundaries: "b" });
      const editor = store.createBot({ name: "Editor", duties: "d", boundaries: "b" });
      const pair = store.createBotDirect(writer.bot.id, editor.bot.id, null);
      const pastPair = store.createBotDirect(writer.bot.id, gone.bot.id, null);
      // A Bot deleted long ago: its direct, and the Writer's direct with it, stay hidden for good.
      store.deleteBot(gone.bot.id);
      const events: ClientEvent[] = [];
      store.onCommit((event) => events.push(event));
      const removed = () => events.flatMap((event) => (event.event === "session.removed" ? [event.id] : []));

      // Any edit of a Bot that stays: its model, its name, its duties. Nothing went out of sight, not
      // even the hidden direct it shares with the deleted Bot.
      store.patchBot(writer.bot.id, { duties: "write more" });
      expect(events.some((event) => event.event === "bot.upsert")).toBe(true);
      expect(removed()).toEqual([]);

      // Deleting one hides its direct and the Bot↔Bot direct it is in; what was hidden already may
      // be named again, nothing else.
      events.length = 0;
      store.deleteBot(writer.bot.id);
      expect(removed()).toContain(writer.direct_session.id);
      expect(removed()).toContain(pair.id);
      expect(removed().filter((id) => id !== pastPair.id).sort()).toEqual([writer.direct_session.id, pair.id].sort());
      expect(removed()).not.toContain(gone.direct_session.id);
      expect(removed()).not.toContain(editor.direct_session.id);
    } finally {
      store.close();
    }
  });
});
