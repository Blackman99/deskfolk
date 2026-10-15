import { describe, expect, test } from "bun:test";
import { HttpError } from "../errors";
import { Store } from "./index";

describe("permission modes (ADR 0092)", () => {
  function card(store: Store, kind_key: string, target: string) {
    const writer = store.createBot({ name: `Writer ${kind_key} ${target}`, duties: "write", boundaries: "none" });
    const trigger = store.postMessage(writer.direct_session.id, { body: "write file" });
    const turn = store.createTurn({ sessionId: writer.direct_session.id, botId: writer.bot.id, triggerMessageId: trigger.id });
    return { bot: writer.bot, approval: store.insertApproval({ turnId: turn.id, messageId: null, kind_key, summary: `${kind_key} ${target}`, target }) };
  }

  test("a Bot without its own mode runs in the app's, auto until you choose one", () => {
    const store = new Store();
    try {
      const { bot } = card(store, "file-write", "/Users/me/p/a.ts");
      expect(store.appPermissionMode()).toBe("auto");
      expect(store.permissionModeFor(bot.id)).toBe("auto");
      store.patchSettingsSync({ permission_mode: "ask_first" });
      expect(store.settingsCached().permission_mode).toBe("ask_first");
      expect(store.permissionModeFor(bot.id)).toBe("ask_first");
      store.patchBot(bot.id, { permission_mode: "allow_all" });
      expect(store.permissionModeFor(bot.id)).toBe("allow_all");
      expect(store.getBot(bot.id).permission_mode).toBe("allow_all");
      store.patchBot(bot.id, { permission_mode: null });
      expect(store.permissionModeFor(bot.id)).toBe("ask_first");
      expect(() => store.patchSettingsSync({ permission_mode: "bypass" as never })).toThrow(HttpError);
    } finally {
      store.close();
    }
  });

  test("only you set a mode: a Bot sets neither its own nor one for a Bot it hires", () => {
    const store = new Store();
    try {
      const { bot } = card(store, "file-write", "/Users/me/p/a.ts");
      expect(() => store.patchBot(bot.id, { permission_mode: "allow_all" }, bot.id)).toThrow("only the user can choose a bot's permission mode");
      expect(() => store.createBot({ name: "Hire", duties: "d", boundaries: "b", permission_mode: "allow_all" }, bot.id)).toThrow("only the user can choose a bot's permission mode");
      // Sent back unchanged with the rest of its profile, it is no change.
      store.patchBot(bot.id, { permission_mode: "ask_first" });
      expect(store.patchBot(bot.id, { duties: "write more", permission_mode: "ask_first" }, bot.id).duties).toBe("write more");
    } finally {
      store.close();
    }
  });

  test("allowing from now on moves the card's Bot to the mode in which the kind no longer asks", () => {
    const store = new Store();
    try {
      store.patchSettingsSync({ permission_mode: "ask_first" });
      const change = card(store, "file-write", "/Users/me/p/a.ts");
      const resolved = store.resolveApproval(change.approval.id, "allow_from_now");
      expect(resolved.status).toBe("allowed_once");
      expect(store.getBot(change.bot.id).permission_mode).toBe("auto");

      const setup = card(store, "mcp-add", "npx server");
      store.resolveApproval(setup.approval.id, "allow_from_now");
      expect(store.getBot(setup.bot.id).permission_mode).toBe("allow_all");

      // Allowing once leaves the mode where it was.
      const once = card(store, "shell", "/Users/me/p");
      store.resolveApproval(once.approval.id, "allow_once");
      expect(store.getBot(once.bot.id).permission_mode).toBeNull();
    } finally {
      store.close();
    }
  });

  test("a mode already wide enough is not narrowed by allowing from now on", () => {
    const store = new Store();
    try {
      const { bot, approval } = card(store, "file-write", "/Users/me/p/a.ts");
      // Moved meanwhile, while the card waited.
      store.patchBot(bot.id, { permission_mode: "allow_all" });
      store.resolveApproval(approval.id, "allow_from_now");
      expect(store.getBot(bot.id).permission_mode).toBe("allow_all");
    } finally {
      store.close();
    }
  });
});
