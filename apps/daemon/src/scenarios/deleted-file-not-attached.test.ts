/**
 * A file a Bot wrote and then deleted does not come with its last line (2026-10-04, real-model run):
 * the lead wrote slogans.md at the workspace root, wrote it again in its ticket's folder and deleted
 * the first; the group then showed two bubbles of slogans.md, one of them a file that was gone.
 */
import { afterEach, expect, test } from "bun:test";
import { call, createScenario, tool, writeFile, type Scenario } from "../test-kit/scenario";

const open: Scenario[] = [];
afterEach(async () => {
  while (open.length) await open.pop()!.close();
});

test("what a Bot deleted is not attached to its segment's end", async () => {
  const h = await createScenario({ learning: true });
  open.push(h);
  const [bot] = h.createBots("设计师");
  const direct = h.direct(bot!);
  const dir = () => h.store.db.query<{ dir: string }, []>("SELECT dir FROM tickets ORDER BY created_at LIMIT 1").get()!.dir;
  h.script(bot!).handle(({ hop }) => {
    if (hop === 1) return call(writeFile("slogans.md", "1. 一杯好咖啡\n"));
    if (hop === 2) return call(writeFile(`${dir()}/slogans.md`, "1. 一杯好咖啡\n"));
    if (hop === 3) return call(tool("delete_file", { path: "slogans.md" }));
    return call(tool("end_turn", { reason: "done" }));
  });
  h.postUser(direct, "写三句宣传语，写成 slogans.md");
  await h.waitIdle({ timeoutMs: 15_000 });

  const attached = h.messages(direct).filter((message) => message.kind === "bot").flatMap((message) => message.attachments.map((a) => a.workspace_relpath));
  expect(attached).toEqual([`${dir()}/slogans.md`]);
});
