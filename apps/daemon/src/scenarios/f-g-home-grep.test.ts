/**
 * ADR 0040 fixture F-g: a search of your whole home folder, learned as a lesson and run again.
 *
 * On 2026-09-28 a Bot ran `grep -rn "…" /Users/<you>/`, which ran into the shell's 600 s timeout.
 * That evening it wrote the lesson into its memory; the next morning the same Bot ran the same kind
 * of search and timed out again. A memory is text the Bot may or may not act on.
 *
 * Since ADR 0040 P1 (the static search guard): a recursive search whose root resolves to your home
 * folder — written as the path, as `~/`, as `cd ~ && … .` or as `find ~` — is refused before it
 * runs, whatever the approval settings say, and the refusal says how to scope it; the same search
 * scoped to the workspace still runs as before. This fixture never grants an approval, so a search
 * this guard let through would still be caught here by never running.
 *
 * The guard's own tests (`search-guard.test.ts`, `workspace-tools.test.ts`) cover two cases this
 * fixture does not, since nothing is spawned there: a search written with `$HOME` (`grep -r x
 * $HOME`), and the refusal holding once the command kind is always allowed.
 */
import { afterEach, expect, test } from "bun:test";
import { homedir } from "node:os";
import { call, createScenario, say, shell, type Scenario } from "../test-kit/scenario";

const open: Scenario[] = [];
afterEach(async () => {
  while (open.length) await open.pop()!.close();
});

// POSIX only, like the guard itself (`toolShell().kind === "sh"`, which win32 never returns).
test.skipIf(process.platform === "win32")("a search rooted at your home folder is refused before it runs, however it is written", async () => {
  const h = await createScenario();
  open.push(h);
  const [director] = h.createBots("视频导演");
  const dm = h.direct(director!);
  h.store.rememberMemory({
    bot_id: director!.id,
    subject: "全盘 grep 会超时",
    body: "在整个用户目录下 grep -r 会跑满 600 秒超时，要先限定到工作区里的子目录。",
  });
  const home = `${homedir()}/`;
  const searches = [
    `grep -rn "BEACON ZERO" ${home}`,
    `cd ~ && grep -r "BEACON ZERO" .`,
    `find ~ -name "*.md"`,
  ];
  h.script(director!, dm).reply(
    ...searches.map((command) => call(shell(command))),
    call(shell(`grep -rn "BEACON ZERO" .`)),
    say("工作区里没有写过 BEACON ZERO 的设定"),
  );

  h.postUser(dm, "找一下哪里写过 BEACON ZERO 的设定");
  await h.waitIdle();

  const ran = h.toolCalls(director!, "shell").map(({ args, approval, result }) => ({ command: args.command, approval, ok: result?.ok ?? null }));
  // Each is turned away on the spot: no approval card, a failed result the Bot reads on its next hop.
  expect(ran.slice(0, 3)).toEqual(searches.map((command) => ({ command, approval: null, ok: false })));
  // Scoped to the workspace, the same search runs.
  expect(ran[3]).toEqual({ command: `grep -rn "BEACON ZERO" .`, approval: null, ok: true });
});
