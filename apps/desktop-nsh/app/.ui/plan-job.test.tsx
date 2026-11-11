import { expect, test } from "nsh/test";
import { openStory } from "./fixture";

const opened = async () => {
  const app = await openStory("plan");
  await app.waitFor("id:plan-overview", { timeout: 10_000 });
  const logged = (line: string) => app.texts().some((t) => t.includes(line));
  return { app, logged };
};

test("the overview reads tickets by state and checks passed; a state opens the board on it", async () => {
  const { app } = await opened();
  expect(app.texts()).toContain("1/3");
  expect(app.texts()).toContain("进行中");
  await app.press("id:plan-ticket-state-doing");
  await app.waitUntil(() => app.texts().includes("focus:doing"));
});

test("what you asked of the job: your words, how often, what it inherits and what waits for you", async () => {
  const { app } = await opened();
  expect(app.texts()).toContain("「片长约 2 分钟」");
  expect(app.texts()).toContain("已说 3 次（跨 2 件事）");
  expect(app.texts()).toContain("转述：母带约 120 秒");
  expect(app.texts()).toContain("继承自「EP01」的 1 条");
  expect(app.texts()).toContain("待你确认");
  expect(app.texts()).toContain("要取代 R-9「片长约 2 分钟」");
  // Three are in force (the offer is not counted).
  expect(app.texts()).toContain("3");
});

test("a press goes to the daemon and the plan that comes back replaces the ledger", async () => {
  const { app, logged } = await opened();
  await app.press("id:requirement-offer-confirm");
  await app.waitUntil(() => logged("requirement:offer:confirm"));
  await app.waitFor("id:requirements-proposed", { state: "gone" });
  await app.press("id:requirement-arm-not_here");
  await app.waitUntil(() => logged("requirement:arm:not_here"));
  // Set aside for this plan: listed apart, struck through, offering to bring it back.
  await app.waitFor("id:requirements-excluded");
  expect(app.shows("id:requirement-arm-here_again")).toBe(true);
});

test("a refused press says so on its entry; the source jumps to the line you said, a ticket's name shows it", async () => {
  const { app, logged } = await opened();
  await app.press("id:requirement-cut-waive");
  await app.waitFor("id:requirement-error");
  expect(app.texts()).toContain("没做成，再试一次。");
  await app.press("id:requirement-run >> id:requirement-jump");
  await app.waitUntil(() => logged("jump:group-1:m1"));
  await app.press("id:requirement-ticket");
  await app.waitUntil(() => logged("ticket:tk-1"));
});

test("a retrospective reads its findings and changes; 撤销 takes one back and its diff opens on a press", async () => {
  const { app, logged } = await opened();
  expect(app.texts()).toContain("让你返工的做法");
  expect(app.texts()).toContain("没写进去：太长了");
  // A change that was not made has no undo.
  expect(app.shows("id:retro-undo-2")).toBe(false);
  await app.press("id:retro-diff-toggle-1");
  await app.waitFor("id:retro-line-add");
  expect(app.texts()).toContain("2. 成文。先确认口径。");
  await app.press("id:retro-diff-toggle-0");
  await app.waitFor("id:retro-after");
  await app.press("id:retro-undo-0");
  await app.waitUntil(() => logged("undo:retro-1:0"));
  await app.waitFor("id:retro-undo-0", { state: "gone" });
  expect(app.texts()).toContain("已撤销");
});

test("who does what: each Bot's tickets beside its turns, the idle owner marked, a deleted Bot named so", async () => {
  const { app } = await opened();
  await app.waitFor("id:job-division");
  expect(app.shows("id:job-division-bot-writer")).toBe(true);
  expect(app.texts()).toContain("#01 #02");
  expect(app.texts()).toContain("5  1 在别人的任务上 · 1 没归任务");
  expect(app.texts()).toContain("已删除");
  expect(app.texts()).toContain("负责人是整理器开任务时按「流程与分工」先填的，不是谁实际在做。");
});

test("the engine says which it is, why, what it leaves off, and opens Roles", async () => {
  const { app, logged } = await opened();
  expect(app.texts()).toContain("引擎：Claude Code");
  expect(app.texts()).toContain("这套引擎没开：复盘、分工 · 用它的会话 2 个");
  expect(app.texts()).toContain("这套引擎的环节都开着 · 用它的会话 1 个");
  expect(app.count("id:job-engine-stopped")).toBe(1);
  expect(app.count("id:job-engine-open")).toBe(1);
  await app.press("id:job-engine-open");
  await app.waitUntil(() => logged("engine:open"));
});

test("a move over an open hand-over asks first; keeping the card drops it, moving anyway sends it", async () => {
  const { app, logged } = await opened();
  expect(app.shows("id:ticket-confirm")).toBe(false);
  await app.press("id:request-review-move");
  await app.waitFor("id:ticket-confirm");
  await app.press("id:ticket-confirm-keep");
  await app.waitFor("id:ticket-confirm", { state: "gone" });
  await app.press("id:request-review-move");
  await app.press("id:ticket-confirm-go");
  await app.waitUntil(() => logged("moved:tk-3:doing"));
  await app.waitFor("id:ticket-confirm", { state: "gone" });
});

test("what a ticket waits for: the others to tick, a loop or a parked one cannot be chosen", async () => {
  const { app, logged } = await opened();
  await app.waitFor("id:ticket-depends");
  // tk-2 waits on tk-3: choosing it for tk-3 would loop; tk-4 is parked.
  expect(app.enabled("id:ticket-depends-2 >> role:checkbox")).toBe(false);
  expect(app.enabled("id:ticket-depends-4 >> role:checkbox")).toBe(false);
  expect(app.enabled("id:ticket-depends-1 >> role:checkbox")).toBe(true);
  await app.press("id:ticket-depends-1 >> role:checkbox");
  await app.waitUntil(() => logged("patchTicket:tk-3:depends="));
});
