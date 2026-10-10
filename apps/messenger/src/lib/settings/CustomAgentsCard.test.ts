import { expect, test } from "bun:test";
import type { AgentsStatusResponse, CustomAgent } from "@real-bot/protocol";
import { ApiError } from "../api.ts";
import { copyFor } from "../copy.ts";
import { click, fill, render } from "../test-render.ts";
import CustomAgentsCard from "./CustomAgentsCard.svelte";
import { parseArgs } from "./agents.ts";

const t = copyFor("zh");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const mine: CustomAgent = { id: "ca-1", name: "my-agent", command: "/usr/local/bin/my-agent", args: ["acp", "--stdio"] };
const other: CustomAgent = { id: "ca-2", name: "other", command: "/opt/other", args: [] };

function open(agents: CustomAgent[], answer?: (sent: unknown[]) => Promise<AgentsStatusResponse>) {
  const sent: unknown[][] = [];
  const answers: AgentsStatusResponse[] = [];
  const api = {
    setCustomAgents: (list: unknown[]) => {
      sent.push(list);
      return answer ? answer(list) : Promise.resolve({ items: [], custom_agents: list as CustomAgent[] });
    },
  };
  const view = render(CustomAgentsCard, { agents, api: api as never, t, onChange: (response: AgentsStatusResponse) => answers.push(response) });
  return { ...view, sent, answers };
}

function submitAdd(view: { host: HTMLElement }) {
  view.host.querySelector<HTMLFormElement>("[data-custom-add]")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
}

test("arguments are one per line, trimmed, blank lines dropped, spaces inside a line kept", () => {
  expect(parseArgs("acp\n  --stdio \n\n--name=my agent\r\n")).toEqual(["acp", "--stdio", "--name=my agent"]);
  expect(parseArgs("")).toEqual([]);
});

test("your agents are listed with the command each runs, or the card says there are none", () => {
  const view = open([mine, other]);
  expect([...view.host.querySelectorAll("[data-custom-name]")].map((name) => name.textContent)).toEqual(["my-agent", "other"]);
  expect([...view.host.querySelectorAll("[data-custom-command]")].map((command) => command.textContent)).toEqual(["/usr/local/bin/my-agent acp --stdio", "/opt/other"]);
  expect(view.host.querySelector("[data-custom-empty]")).toBeNull();
  view.close();

  const empty = open([]);
  expect(empty.host.querySelector("[data-custom-empty]")?.textContent).toBe(t.agents.custom.empty);
  empty.close();
});

test("adding one sends the whole list: yours by their ids, the new one without, its arguments split by line", async () => {
  const view = open([mine]);
  const add = view.host.querySelector<HTMLButtonElement>("[data-custom-add] button[type=submit]")!;
  // A name and a command first.
  expect(add.disabled).toBe(true);
  fill(view.host.querySelector("[data-custom-name-input]"), " zed ");
  fill(view.host.querySelector("[data-custom-command-input]"), "/usr/local/bin/zed-acp");
  fill(view.host.querySelector("[data-custom-args-input]"), "--acp\n\n  --verbose  \n");
  expect(add.disabled).toBe(false);
  submitAdd(view);
  await sleep(0);
  expect(view.sent).toEqual([[
    { id: "ca-1", name: "my-agent", command: "/usr/local/bin/my-agent", args: ["acp", "--stdio"] },
    { name: "zed", command: "/usr/local/bin/zed-acp", args: ["--acp", "--verbose"] },
  ]]);
  // The daemon's answer goes to the host, and the fields are empty for the next one.
  expect(view.answers).toHaveLength(1);
  expect(view.host.querySelector<HTMLInputElement>("[data-custom-name-input]")?.value).toBe("");
  expect(view.host.querySelector<HTMLInputElement>("[data-custom-command-input]")?.value).toBe("");
  expect(view.host.querySelector<HTMLTextAreaElement>("[data-custom-args-input]")?.value).toBe("");
  view.close();
});

test("removing one sends the list without it; one a Bot runs on stays, and the daemon's words name the Bots", async () => {
  let refuse = false;
  const view = open([mine, other], async (list) => {
    if (refuse) throw new ApiError(409, "conflict", "my-agent runs Researcher, Writer: move those Bots to another runner first");
    return { items: [], custom_agents: list as CustomAgent[] };
  });
  click(view.host.querySelectorAll("[data-custom-remove]")[1]);
  await sleep(0);
  expect(view.sent).toEqual([[{ id: "ca-1", name: "my-agent", command: "/usr/local/bin/my-agent", args: ["acp", "--stdio"] }]]);
  expect(view.host.querySelector("[data-custom-error]")).toBeNull();

  refuse = true;
  click(view.host.querySelectorAll("[data-custom-remove]")[0]);
  await sleep(0);
  expect(view.sent[1]).toEqual([{ id: "ca-2", name: "other", command: "/opt/other", args: [] }]);
  const error = view.host.querySelector("[data-custom-error]");
  expect(error?.getAttribute("data-custom-error")).toBe("in_use");
  expect(error?.textContent).toContain(t.agents.custom.inUse);
  expect(error?.textContent).toContain("Researcher, Writer");
  // Nothing was told to the host: the list is still the daemon's from before.
  expect(view.answers).toHaveLength(1);
  view.close();
});

test("renaming keeps the id, the command and the arguments", async () => {
  const view = open([mine, other]);
  click(view.host.querySelector("[data-custom-rename]"));
  const input = view.host.querySelector<HTMLInputElement>("[data-custom-rename-input]")!;
  expect(input.value).toBe("my-agent");
  fill(input, "  renamed ");
  view.host.querySelector<HTMLFormElement>(".custom-row")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  await sleep(0);
  expect(view.sent).toEqual([[
    { id: "ca-1", name: "renamed", command: "/usr/local/bin/my-agent", args: ["acp", "--stdio"] },
    { id: "ca-2", name: "other", command: "/opt/other", args: [] },
  ]]);
  expect(view.host.querySelector("[data-custom-rename-input]")).toBeNull();
  view.close();

  // Cancel puts the name back without asking the daemon.
  const cancelled = open([mine]);
  click(cancelled.host.querySelector("[data-custom-rename]"));
  click([...cancelled.host.querySelectorAll("button")].find((button) => button.textContent?.trim() === t.agents.custom.cancel));
  expect(cancelled.sent).toEqual([]);
  expect(cancelled.host.querySelector("[data-custom-name]")?.textContent).toBe("my-agent");
  cancelled.close();
});

test("a command or name the daemon refuses says why, and the fields keep what was typed", async () => {
  const view = open([], async () => { throw new ApiError(422, "invalid_args", "zed: the command must be an absolute path"); });
  fill(view.host.querySelector("[data-custom-name-input]"), "zed");
  fill(view.host.querySelector("[data-custom-command-input]"), "zed-acp");
  submitAdd(view);
  await sleep(0);
  const error = view.host.querySelector("[data-custom-error]");
  expect(error?.getAttribute("data-custom-error")).toBe("invalid");
  expect(error?.textContent).toContain(t.agents.custom.invalid);
  expect(error?.textContent).toContain("must be an absolute path");
  expect(view.host.querySelector<HTMLInputElement>("[data-custom-command-input]")?.value).toBe("zed-acp");
  view.close();

  const down = open([], async () => { throw new Error("network down"); });
  fill(down.host.querySelector("[data-custom-name-input]"), "zed");
  fill(down.host.querySelector("[data-custom-command-input]"), "/bin/zed");
  submitAdd(down);
  await sleep(0);
  expect(down.host.querySelector("[data-custom-error]")?.getAttribute("data-custom-error")).toBe("failed");
  expect(down.host.querySelector("[data-custom-error]")?.textContent?.trim()).toBe(t.agents.custom.failed);
  down.close();
});

test("at the daemon's limit the add form gives way to a note", () => {
  const eight = Array.from({ length: 8 }, (_, index) => ({ id: `ca-${index}`, name: `agent-${index}`, command: "/bin/x", args: [] }));
  const view = open(eight);
  expect(view.host.querySelector("[data-custom-add]")).toBeNull();
  expect(view.host.querySelector("[data-custom-full]")?.textContent).toBe(t.agents.custom.full(8));
  view.close();
});
