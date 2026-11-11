/** What sits around the transcript's edges: welcome, line editor, message index, replying, entries, quotes, reactions. */
import { expect, test } from "nsh/test";
import { openStory } from "./fixture";

const open = async (options: Parameters<typeof openStory>[1] = { height: 3400 }) => {
  const app = await openStory("chat-header", options);
  await app.waitFor("id:header-direct", { timeout: 15_000 });
  return app;
};
type Open = Awaited<ReturnType<typeof open>>;
const logged = (app: Open, line: string) => app.texts().some((t) => t.split(" | ").includes(line));

test("a new direct welcomes with the Bot, its duties and starters that fill the composer", async () => {
  const app = await open();
  expect(app.shows("id:welcome-direct >> id:welcome-identity")).toBe(true);
  expect(app.shows("id:welcome-direct >> id:welcome-duties")).toBe(true);
  expect(app.shows("id:welcome-direct >> text:写东西、改东西")).toBe(true);
  await app.press("id:welcome-direct >> text:交出去，明早看结果");
  await app.waitUntil(() => app.texts().some((t) => t.includes("starter:")));
  await app.press("id:welcome-direct >> id:welcome-identity");
  await app.waitUntil(() => logged(app, "profile:writer"));
  // A group and the file drop say their own thing, and neither offers starters.
  expect(app.shows("id:welcome-group >> text:还没有消息。")).toBe(true);
  expect(app.shows("id:welcome-file >> text:这里还是空的。写几句，或点下面的附件、把文件拖进来。")).toBe(true);
  expect(app.count("id:welcome-group >> id:welcome-duties")).toBe(0);
});

test("the line editor saves with the button and with Enter, but not while saving or on an IME's Enter", async () => {
  const app = await open();
  expect(app.value("id:msg-editor-field")).toBe("片长 30 秒");
  await app.type("id:msg-editor-field", "！");
  await app.waitUntil(() => app.value("id:msg-editor-field") === "片长 30 秒！");
  await app.press("id:msg-editor-save");
  await app.waitUntil(() => logged(app, "save:片长 30 秒！"));
  await app.press("id:msg-editor-cancel");
  await app.waitUntil(() => logged(app, "cancel"));
  // Enter in the field saves as well.
  await app.submit("id:msg-editor-field");
  await app.waitUntil(() => app.texts().some((t) => t.split(" | ").filter((l) => l === "save:片长 30 秒！").length === 2));
  // Saving holds both buttons.
  await app.press("id:toggle-saving");
  await app.waitUntil(() => !app.enabled("id:msg-editor-save"));
  expect(app.enabled("id:msg-editor-cancel")).toBe(false);
  expect(app.shows("id:msg-editor >> text:保存中…") || app.texts().some((t) => t.includes("保存中"))).toBe(true);
});

test("the editor shows why a save did not land", async () => {
  const app = await open();
  expect(app.count("id:msg-editor-error")).toBe(0);
  await app.type("id:msg-editor-field", "错");
  await app.waitFor("id:msg-editor-error");
});

test("the message index jumps to a line, loads earlier ones and names a tick on focus", async () => {
  const app = await open();
  expect(app.count("id:index-stage >> id:message-index")).toBe(1);
  await app.press("id:index-m3");
  await app.waitUntil(() => logged(app, "jump:m3"));
  await app.press("id:index-earlier");
  await app.waitUntil(() => logged(app, "earlier"));
  await app.hover("id:index-m5");
  await app.waitFor("id:message-index-preview", { timeout: 5_000 });
  expect(app.texts()).toContain("再看一眼标题");
});

test("the message index has no strip on a phone", async () => {
  const app = await open({ width: 420, height: 3400 });
  expect(app.count("id:message-index")).toBe(0);
});

test("replying shows the Bots that are about to answer; one opens its profile", async () => {
  const app = await open();
  expect(app.shows("id:replying-one >> text:Editor")).toBe(true);
  expect(app.shows("id:replying-one >> text:思考中")).toBe(true);
  expect(app.count("id:replying-many >> id:replying-card")).toBeLessThanOrEqual(1);
  await app.press("id:replying-one >> text:Editor");
  await app.waitUntil(() => app.texts().some((t) => t.includes("reply-profile:")));
});

test("a Bot's direct opened from a line is a chip that opens it; many collapse into +N", async () => {
  const app = await open();
  await app.press("id:dm-one >> id:bot-dm-trace");
  await app.waitUntil(() => logged(app, "trace"));
  await app.press("id:dm-one >> text:Writer");
  await app.waitUntil(() => logged(app, "open:direct"));
  expect(app.shows("id:dm-many >> id:bot-dm-overflow")).toBe(true);
  expect(app.shows("id:dm-many >> text:+2")).toBe(true);
  await app.press("id:dm-many >> id:bot-dm-overflow");
  await app.waitUntil(() => app.texts().some((t) => /(^| \| )open:filedrop/.test(t)));
});

test("subagent entries open a task: a lone one as a link, several as a card of chips", async () => {
  const app = await open();
  await app.press("id:subagent-one >> id:subagent-t1");
  await app.waitUntil(() => logged(app, "subagent:t1"));
  expect(app.shows("id:subagent-many >> text:校对图表")).toBe(true);
  expect(app.shows("id:subagent-many >> text:失败")).toBe(true);
  await app.press("id:subagent-many >> id:subagent-t2");
  await app.waitUntil(() => logged(app, "subagent:t2"));
});

test("a quote, a reaction chip and an interface change", async () => {
  const app = await open();
  expect(app.count("id:quote-ref")).toBe(1);
  expect(app.texts()).toContain("周报先写本周的数据");
  expect(app.shows("id:reaction-row >> id:reaction-👍")).toBe(true);
  expect(app.count("id:interface-chip")).toBe(2);
  expect(app.count("id:interface-undo")).toBe(1);
  expect(app.texts()).toContain("专注模式 开");
  await app.press("id:interface-undo");
  await app.waitUntil(() => logged(app, "undo:r1"));
  await app.waitFor("id:interface-undo", { state: "gone" });
});
