/**
 * A change after delivery lands in the ticket's own file (2026-10-04, real-model run in a direct).
 * You approved 「咖啡店开业周的活动方案」's plan.md, then asked 「第二天的主题换成手冲咖啡体验课」. The
 * Bot wrote the new plan.md into `01-…每天一个主题/` — a folder it built from the ticket's title; the
 * ticket's folder is `01-…每天一个/`, the title cut short — and handed in the untouched plan.md: the
 * card asked you to approve a change that was not in the file.
 */
import { afterEach, expect, test } from "bun:test";
import { call, createScenario, fileUnder, requestText, tool, writeFile, type Scenario } from "../test-kit/scenario";

const open: Scenario[] = [];
afterEach(async () => {
  while (open.length) await open.pop()!.close();
});

const REQUEST = "写一份咖啡店开业周的活动方案，三天活动，每天一个主题，写成 plan.md";

async function delivered() {
  const h = await createScenario({ learning: true });
  open.push(h);
  const [bot] = h.createBots("设计师");
  const direct = h.direct(bot!);
  const ticket = () => h.store.db.query<{ id: string; dir: string; title: string }, []>("SELECT id, dir, title FROM tickets ORDER BY created_at LIMIT 1").get()!;
  // Your change after delivery is read as about what was delivered (ADR 0057): the job, its ticket.
  h.judge("read_filing").handle((ctx) => fileUnder(undefined, { ticket: ticket().title })(ctx));
  let turns = 0;
  const steps: Array<(hop: number) => ReturnType<typeof call>> = [];
  h.script(bot!).handle(({ hop }) => {
    if (hop === 1) turns++;
    // Its first effect opens the job, then the plan goes in the ticket's folder and is handed in.
    if (turns === 1) return hop === 1 ? call(writeFile("notes.md", "三天，每天一个主题"))
      : hop === 2 ? call(writeFile(`${ticket().dir}/plan.md`, "第一天：开业\n第二天：拉花\n第三天：邻里\n"))
      : hop === 3 ? call(tool("submit", { artifacts: [`${ticket().dir}/plan.md`] })) : call(tool("end_turn", { reason: "done" }));
    return (steps[hop - 1] ?? (() => call(tool("end_turn", { reason: "done" }))))(hop);
  });
  h.postUser(direct, REQUEST);
  await h.waitIdle({ timeoutMs: 15_000 });
  // Opened, made and handed in by one segment: the tick approves it with no card (ADR 0058, 2026-10-06).
  h.tick(new Date(Date.now() + 60_000));
  await h.waitIdle({ timeoutMs: 15_000 });
  expect(h.messages(direct).filter((message) => message.control?.kind === "review_item")).toEqual([]);
  expect(h.store.listSubmissions({ ticketId: ticket().id })).toMatchObject([{ state: "approved" }]);
  return { h, bot: bot!, direct, ticket, steps };
}

test("writing into a ticket-shaped folder no ticket has is refused, naming the ticket's folder", async () => {
  const { h, bot, direct, ticket, steps } = await delivered();
  // The ticket's folder name is its title cut short; the Bot's guess is the whole phrase.
  const guessed = `${ticket().dir.replace(/\/01-.*$/, "")}/01-写一份咖啡店开业周的活动方案，三天活动，每天一个主题`;
  expect(ticket().dir).not.toBe(guessed);
  steps.push(
    () => call(writeFile(`${guessed}/plan.md`, "第一天：开业\n第二天：手冲咖啡体验课\n第三天：邻里\n")),
    () => call(writeFile(`${ticket().dir}/plan.md`, "第一天：开业\n第二天：手冲咖啡体验课\n第三天：邻里\n")),
    () => call(tool("submit", { artifacts: [`${ticket().dir}/plan.md`] })),
  );
  h.postUser(direct, "第二天的主题换成手冲咖啡体验课");
  await h.waitIdle({ timeoutMs: 15_000 });

  const writes = h.toolCalls(bot, "write_file").slice(2);
  expect(writes.map((c) => c.result?.ok)).toEqual([false, true]);
  const told = requestText(h.hops(bot).filter((hop) => hop.hop === 2).at(-1)!.request);
  expect(told).toContain("is no ticket's folder in this job");
  expect(told).toContain(`${ticket().dir}/`);
  expect(h.toolCalls(bot, "submit").at(-1)!.result?.ok).toBe(true);
});

test("handing in the very files already approved is refused: nothing changed", async () => {
  const { h, bot, direct, ticket, steps } = await delivered();
  steps.push(() => call(tool("submit", { artifacts: [`${ticket().dir}/plan.md`] })));
  h.postUser(direct, "第二天的主题换成手冲咖啡体验课");
  await h.waitIdle({ timeoutMs: 15_000 });

  expect(h.toolCalls(bot, "submit").at(-1)!.result).toMatchObject({ ok: false, error: "unchanged" });
  expect(h.store.db.query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM submissions WHERE ticket_id = ?").get(ticket().id)!.n).toBe(1);
});
