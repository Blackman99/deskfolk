import { expect, test } from "bun:test";
import { aMessage, anAttachment } from "../test-fixtures.ts";
import { findAttachmentById, findAttachmentByPath, siblingsForPath } from "./artifact-lookup.ts";

test("findAttachmentByPath scans every message for a matching relpath", () => {
  const att = anAttachment({ id: "att-2", workspace_relpath: "outline/ep-12.md" });
  const messages = [
    aMessage({ id: "m1", attachments: [] }),
    aMessage({ id: "m2", attachments: [att] }),
  ];
  expect(findAttachmentByPath(messages, "outline/ep-12.md")).toBe(att);
  expect(findAttachmentByPath(messages, "missing.md")).toBeNull();
});

test("findAttachmentById scans every message for a matching id", () => {
  const att = anAttachment({ id: "att-9" });
  const messages = [aMessage({ id: "m1", attachments: [att] })];
  expect(findAttachmentById(messages, "att-9")).toBe(att);
  expect(findAttachmentById(messages, "att-missing")).toBeNull();
});

test("siblingsForPath, given the message it came from, returns what that message handed over", () => {
  const attA = anAttachment({ id: "a", workspace_relpath: "outline/ep-12.md" });
  const attB = anAttachment({ id: "b", workspace_relpath: "outline/ep-12-notes.md" });
  const owner = aMessage({ id: "m1", attachments: [attA, attB] });
  const messages = [owner];
  expect(siblingsForPath(messages, "outline/ep-12.md", attA, "m1")).toEqual([attA, attB]);
});

test("siblingsForPath synthesises a virtual sibling for a path named in the body but never uploaded", () => {
  const attA = anAttachment({ id: "a", workspace_relpath: "outline/ep-12.md" });
  const owner = aMessage({
    id: "m1",
    body: "附件：outline/ep-13.md",
    attachments: [attA],
  });
  const messages = [owner];
  const siblings = siblingsForPath(messages, "outline/ep-12.md", attA, "m1");
  // The line in the body comes first: handedOverPaths reads what the body names before what the
  // message already carries.
  expect(siblings.map((row) => row.workspace_relpath)).toEqual(["outline/ep-13.md", "outline/ep-12.md"]);
  const virtual = siblings.find((row) => row.workspace_relpath === "outline/ep-13.md")!;
  expect(virtual.id).toBe("virtual-m1-outline/ep-13.md");
  expect(virtual.message_id).toBe("m1");
});

test("siblingsForPath prefers the runtime's own preview siblings over an owning message's", () => {
  const owner = aMessage({ id: "m1", attachments: [anAttachment({ id: "a" })] });
  const previewSiblings = [anAttachment({ id: "z", workspace_relpath: "z.md" })];
  // No messageId, so the message-handoff branch never runs; previewSiblings wins outright.
  expect(siblingsForPath([owner], "z.md", undefined, null, previewSiblings)).toBe(previewSiblings);
});

test("siblingsForPath falls back to the attachment's own owning message when nothing else names one", () => {
  const att = anAttachment({ id: "a", workspace_relpath: "a.md", message_id: "m1" });
  const sibling = anAttachment({ id: "b", workspace_relpath: "b.md", message_id: "m1" });
  const owner = aMessage({ id: "m1", attachments: [att, sibling] });
  expect(siblingsForPath([owner], "a.md", att)).toEqual([att, sibling]);
});

test("siblingsForPath scans every message for one that names the path, then gives up with just the attachment", () => {
  const att = anAttachment({ id: "a", workspace_relpath: "a.md" });
  const carrier = aMessage({ id: "m2", attachments: [anAttachment({ id: "c", workspace_relpath: "a.md" })] });
  expect(siblingsForPath([aMessage({ id: "m1" }), carrier], "a.md")).toBe(carrier.attachments);
  expect(siblingsForPath([aMessage({ id: "m1" })], "a.md", att)).toEqual([att]);
  expect(siblingsForPath([aMessage({ id: "m1" })], "a.md")).toEqual([]);
});
