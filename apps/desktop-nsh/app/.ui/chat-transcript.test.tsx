/** The transcript's groups: your lines, a Bot's replies, the system lines, and the subagent popup. */
import { expect, test } from "nsh/test";
import { copyFor } from "../src/m/copy.ts";
import { openStory } from "./fixture";

const t = copyFor("zh");

async function open(section: string) {
  const app = await openStory("chat-transcript");
  await app.waitFor(`id:show-${section}`, { timeout: 15_000 });
  await app.press(`id:show-${section}`);
  return app;
}

test("a run of your lines counts itself, and a changed line opens what it said before", async () => {
  const app = await open("user");
  await app.waitFor("id:run-you");
  expect(app.texts()).toContain(t.chat.messageCount(3));
  expect(app.texts()).toContain("再加一段风险");
  expect(app.texts()).toContain(t.chat.edited);
  expect(app.shows("id:run-you >> id:msg-versions")).toBe(false);
  await app.press("id:run-you >> id:msg-edited");
  await app.waitFor("id:run-you >> id:msg-versions");
  expect(app.texts()).toContain(t.chat.earlierVersions);
  expect(app.texts()).toContain("再加一段");
  // Its reaction sits under the bubble.
  expect(app.shows("id:run-you >> id:reaction-🎉")).toBe(true);
});

test("a line no Bot has read yet says so, and can be read now or taken back", async () => {
  const app = await open("user");
  await app.waitFor("id:run-you >> id:msg-queued");
  expect(app.texts()).toContain(t.chat.queuedNextStep);
  await app.press("id:run-you >> id:msg-withdraw");
  await app.waitUntil(() => app.texts().includes("withdraw:you-3"));
  await app.press("id:run-you >> id:msg-insert-now");
  await app.waitUntil(() => app.texts().includes("insert:you-3"));
});

// The pill is an overlay over its line (`message-pill.tsx`), outside the line's views for a
// selector: one pill is up at a time, so it is named on its own.
test("the hover pill shows over a line and copies it, quotes it, opens its menu", async () => {
  const app = await open("user");
  await app.waitFor("id:run-annotated");
  expect(app.shows("id:msg-toolbar")).toBe(false);
  await app.hover("id:run-annotated >> id:msg-bubble");
  await app.waitFor("id:msg-toolbar");
  await app.press("id:msg-toolbar >> id:act-copy");
  await app.waitUntil(() => app.texts().includes("copy:批注发出去了"));
  await app.waitFor(`text:✓ ${t.chat.copied}`);
  await app.press("id:msg-toolbar >> id:act-reply");
  await app.waitUntil(() => app.texts().includes("quote:you-annotated"));
  await app.press("id:msg-toolbar >> id:act-more");
  await app.waitUntil(() => app.texts().some((line) => line.startsWith("menu:you-annotated")));
  // A line that already quotes another cannot be quoted again. The last line's pill lingers a moment first.
  await app.hover("id:run-quote >> id:msg-bubble");
  await app.wait(400);
  expect(app.count("id:msg-toolbar")).toBe(1);
  expect(app.shows("id:msg-toolbar >> id:act-reply")).toBe(false);
});

test("a right click on a line asks the shell for its menu", async () => {
  const app = await open("user");
  await app.waitFor("id:run-quote >> id:quote-ref");
  await app.rightClick("id:run-quote >> id:msg-bubble");
  await app.waitUntil(() => app.texts().some((line) => line.startsWith("menu:you-quote")));
});

test("a line is changed in place: the pill's edit swaps the words for a field", async () => {
  const app = await open("user");
  await app.waitFor("id:run-edit");
  await app.hover("id:run-edit >> id:msg-bubble");
  await app.press("id:msg-toolbar >> id:act-edit");
  await app.waitFor("id:run-edit >> id:msg-editor");
  expect(app.value("id:run-edit >> id:msg-editor-field")).toBe("待改的一句");
  // While it is a field the pill is gone.
  expect(app.shows("id:msg-toolbar")).toBe(false);
});

test("a taken-back line is a notice with the way back to its words", async () => {
  const app = await open("user");
  await app.waitFor("id:run-withdrawn >> id:msg-withdrawn");
  expect(app.texts()).toContain(t.chat.lineWithdrawn);
  expect(app.texts()).not.toContain("撤回的话");
  await app.press("id:run-withdrawn >> id:msg-re-edit");
  await app.waitUntil(() => app.texts().includes("re-edit:you-withdrawn"));
});

test("a locked conversation leaves no reaction, reply or take-back", async () => {
  const app = await open("user");
  await app.press("id:toggle-locked");
  await app.waitFor("id:run-quote");
  await app.hover("id:run-annotated >> id:msg-bubble");
  await app.waitFor("id:msg-toolbar");
  expect(app.shows("id:msg-toolbar >> id:act-reply")).toBe(false);
  expect(app.shows("id:msg-toolbar >> id:react-👍")).toBe(false);
  expect(app.shows("id:run-you >> id:msg-withdraw")).toBe(false);
});

test("an annotation sent with a line shows as a card under it", async () => {
  const app = await open("user");
  await app.waitFor("id:run-annotated >> id:annotation-cards");
  expect(app.texts()).toContain(t.stream.annotationStatusOpen);
});

test("a Bot's reply: name, tags, the parts of one reply, a foot with the time and its reaction", async () => {
  const app = await open("bot");
  await app.waitFor("id:run-bot");
  expect(app.texts()).toContain("Writer");
  expect(app.texts()).toContain(t.chat.botBadge);
  expect(app.texts()).toContain("claude-sonnet");
  expect(app.texts()).toContain("第二部分补在文末，请看一下。");
  expect(app.shows("id:run-bot >> id:reaction-👍")).toBe(true);
  // The first part gives up its foot to the hover actions; the last one keeps it.
  expect(app.count("id:run-bot >> id:msg-foot")).toBe(1);
  await app.press("id:run-bot >> id:bot-avatar");
  await app.waitUntil(() => app.texts().includes("profile:bot-writer"));
});

test("the hover pill of a Bot's part carries the part's time and copies the message", async () => {
  const app = await open("bot");
  await app.waitFor("id:run-bot >> id:msg-bot-1");
  await app.hover("id:run-bot >> id:msg-bot-1");
  await app.waitFor("id:msg-toolbar");
  expect(app.shows("id:msg-toolbar >> id:msg-when-peek")).toBe(true);
  await app.press("id:msg-toolbar >> id:act-copy");
  await app.waitUntil(() => app.texts().some((line) => line.startsWith("copy:周报的")));
});

test("the pill stays while the pointer rests on it, and lingers a moment after it leaves", async () => {
  const app = await open("bot");
  await app.waitFor("id:run-bot >> id:msg-bot-1");
  await app.hover("id:run-bot >> id:msg-bot-1");
  await app.waitFor("id:msg-toolbar");
  // Off the part onto its pill: it stays past the grace.
  await app.hover("id:msg-toolbar");
  await app.wait(400);
  expect(app.count("id:msg-toolbar")).toBe(1);
  // Off both: still there a moment (a slanted path to it leaves the part first), then gone.
  await app.hover("id:show-user");
  await app.wait(60);
  expect(app.count("id:msg-toolbar")).toBe(1);
  await app.wait(400);
  expect(app.count("id:msg-toolbar")).toBe(0);
});

test("a working bubble shows what it has said, its cursor, and where it is", async () => {
  const app = await open("bot");
  await app.waitFor("id:run-stream >> id:streaming-turn-live");
  expect(app.texts()).toContain(t.sidebar.statusRunning);
  expect(app.shows("id:run-stream >> id:streaming-cursor")).toBe(true);
  expect(app.shows("id:run-stream >> id:stream-duration")).toBe(true);
  // One that has said nothing shows no text, no cursor, but the same last line.
  expect(app.shows("id:run-stream-quiet >> id:streaming-cursor")).toBe(false);
  expect(app.shows("id:run-stream-quiet >> id:stream-foot")).toBe(true);
});

test("focus mode leaves out the tags and times", async () => {
  const app = await open("bot");
  await app.waitFor("id:run-bot");
  expect(app.texts()).toContain(t.chat.botBadge);
  await app.press("id:toggle-focus");
  await app.waitUntil(() => !app.texts().includes(t.chat.botBadge));
  expect(app.shows("id:run-bot >> id:msg-foot")).toBe(false);
  expect(app.shows("id:run-stream >> id:stream-duration")).toBe(false);
});

test("an interrupted turn offers Continue; the app's own line has its mark, name and tag", async () => {
  const app = await open("system");
  await app.waitFor("id:row-interrupt >> id:continue-turn");
  expect(app.texts()).toContain("中断");
  await app.waitFor("id:row-unreachable >> id:continue-turn");
  expect(app.count("id:continue-turn")).toBe(2);
  await app.waitFor("id:row-app >> id:app-avatar");
  expect(app.texts()).toContain(t.chat.appName);
  expect(app.texts()).toContain(t.chat.appBadge);
  expect(app.texts()).toContain("已停下 Writer 的这一轮。");
  expect(app.shows("id:row-app >> id:continue-turn")).toBe(false);
});

test("a job's question shows as its card", async () => {
  const app = await open("system");
  await app.waitFor("id:row-work");
  expect(app.texts()).toContain("预告片用哪一版配乐？");
  expect(app.shows("id:row-work >> id:continue-turn")).toBe(false);
});

test("a system line's Bot name opens its profile; a right click asks for the menu", async () => {
  const app = await open("system");
  await app.waitFor("id:row-interrupt");
  await app.press("id:row-interrupt >> id:sender-name");
  await app.waitUntil(() => app.texts().includes("profile:bot-writer"));
  await app.rightClick("id:row-interrupt >> id:system-card");
  await app.waitUntil(() => app.texts().some((line) => line.startsWith("menu:sys-interrupt")));
});

test("the subagent popup shows what it was asked, what it said, its calls and where it is", async () => {
  const app = await open("dialog");
  await app.press("id:open-running");
  await app.waitFor("id:subagent-prompt", { timeout: 10_000 });
  expect(app.texts()).toContain("查周报数据来源");
  expect(app.texts()).toContain("把周报用到的数据来源列一下");
  await app.waitFor("id:subagent-say");
  await app.waitFor("id:subagent-foot");
  expect(app.texts()).toContain("pnpm build");
  expect(app.shows("id:subagent-facts")).toBe(true);
  await app.press("id:modal-close");
  await app.waitUntil(() => !app.shows("id:subagent-foot"));
});

test("a subagent that is done keeps no foot, and one that cannot be read says so", async () => {
  const app = await open("dialog");
  await app.press("id:open-done");
  await app.waitFor(`text:${t.project.taskStepsGone}`, { timeout: 10_000 });
  expect(app.shows("id:subagent-foot")).toBe(false);
  await app.press("id:modal-close");
  await app.waitUntil(() => !app.shows(`text:${t.project.taskStepsGone}`));
  await app.press("id:open-lost");
  await app.waitFor(`text:${t.project.taskReadFailed}`, { timeout: 10_000 });
});
