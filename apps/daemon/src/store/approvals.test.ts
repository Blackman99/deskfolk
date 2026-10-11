import { describe, expect, test } from "bun:test";
import { Store } from "./index";

describe("Always allow rules (ADR 0087)", () => {
  function card(store: Store, kind_key: string, target: string, allow_scope?: string | null) {
    const writer = store.createBot({ name: `Writer ${target}`, duties: "write", boundaries: "none" });
    const trigger = store.postMessage(writer.direct_session.id, { body: "write file" });
    const turn = store.createTurn({ sessionId: writer.direct_session.id, botId: writer.bot.id, triggerMessageId: trigger.id });
    return store.insertApproval({ turnId: turn.id, messageId: null, kind_key, summary: `${kind_key} ${target}`, target, allow_scope });
  }

  test("Always allow writes the scope the card proposed; a scope you name wins", () => {
    const store = new Store();
    try {
      const a = card(store, "outside-write", "/Users/me/p/src/a.ts", "/Users/me/p");
      expect(a.allow_scope).toBe("/Users/me/p");
      store.resolveApproval(a.id, "always_allow");
      const b = card(store, "outside-read", "/Users/me/q/b.md", "/Users/me/q");
      store.resolveApproval(b.id, "always_allow", "/Users/me/q/b.md");
      // An old card, from before cards proposed a scope: its target.
      const c = card(store, "outside-read", "/Users/me/r/c.md");
      expect(c.allow_scope).toBeNull();
      store.resolveApproval(c.id, "always_allow");
      expect(store.listAllowRules().map((r) => [r.kind_key, r.scope])).toEqual([
        ["outside-write", "/Users/me/p"],
        ["outside-read", "/Users/me/q/b.md"],
        ["outside-read", "/Users/me/r/c.md"],
      ]);
    } finally {
      store.close();
    }
  });

  test("a folder rule covers what is in it, not a sibling that shares its name's start", () => {
    const store = new Store();
    try {
      store.createAllowRule("outside-write", "/Users/me/p");
      expect(store.matchesAllowRule("outside-write", "/Users/me/p")).toBe(true);
      expect(store.matchesAllowRule("outside-write", "/Users/me/p/.changeset/x.md")).toBe(true);
      expect(store.matchesAllowRule("outside-write", "/Users/me/p2/x.md")).toBe(false);
      expect(store.matchesAllowRule("outside-write", "/Users/me/x.md")).toBe(false);
    } finally {
      store.close();
    }
  });

  test("what you let a Bot write somewhere it may read there; reading does not let it write", () => {
    const store = new Store();
    try {
      store.createAllowRule("outside-write", "/Users/me/p");
      store.createAllowRule("outside-read", "/Users/me/docs");
      expect(store.matchesAllowRule("outside-read", "/Users/me/p/README.md")).toBe(true);
      expect(store.matchesAllowRule("outside-write", "/Users/me/docs/a.md")).toBe(false);
      expect(store.matchesAllowRule("unconstrained-shell", "/Users/me/p")).toBe(false);
    } finally {
      store.close();
    }
  });
});
