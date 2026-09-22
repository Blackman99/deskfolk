import { expect, test } from "bun:test";
import { Store } from "./index";
import { MESSAGE_PAGE_BYTES } from "./messages";

test("a page of very long messages is cut by bytes and continues from its cursor", () => {
  const store = new Store();
  const one = store.createBot({ name: "Writer", duties: "write", boundaries: "none" });
  const two = store.createBot({ name: "Editor", duties: "edit", boundaries: "none" });
  const group = store.createGroup({ name: "Long", members: [one.bot.id, two.bot.id] });
  // Four messages, each a third of the budget: two and a bit fill it.
  const body = "x".repeat(Math.floor(MESSAGE_PAGE_BYTES / 3));
  for (let i = 0; i < 4; i++) store.postMessage(group.id, { body: `${i}${body}` });

  const first = store.listMessages(group.id);
  expect(first.items.length).toBeLessThan(4);
  expect(first.next).not.toBeNull();

  const seen = new Set(first.items.map((m) => m.id));
  let cursor = first.next;
  while (cursor) {
    const page = store.listMessages(group.id, { cursor });
    expect(page.items.length).toBeGreaterThan(0);
    for (const message of page.items) seen.add(message.id);
    cursor = page.next;
  }
  // Every message is reachable, just across more pages than before.
  expect(seen.size).toBe(4);
  store.close();
});

test("ordinary messages still come back as one page with no cursor", () => {
  const store = new Store();
  const one = store.createBot({ name: "Writer", duties: "write", boundaries: "none" });
  const two = store.createBot({ name: "Editor", duties: "edit", boundaries: "none" });
  const group = store.createGroup({ name: "Short", members: [one.bot.id, two.bot.id] });
  for (let i = 0; i < 20; i++) store.postMessage(group.id, { body: `message ${i}` });
  const page = store.listMessages(group.id);
  expect(page.items).toHaveLength(20);
  expect(page.next).toBeNull();
  store.close();
});
