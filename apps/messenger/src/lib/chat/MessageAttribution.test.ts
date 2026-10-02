import { expect, test } from "bun:test";
import { copyFor } from "../copy.ts";
import { aMessage } from "../test-fixtures.ts";
import { click, render } from "../test-render.ts";
import MessageAttribution from "./MessageAttribution.svelte";

const plans = [
  { id: "plan-a", title: "让审片员回复视频导演，说明未回复原因并给出审片意见。", tickets: [{ id: "ticket-a", title: "回复视频导演" }] },
  { id: "plan-b", title: "海报", tickets: [] },
];
const filed = (filings: { task_id: string; ticket_id?: string | null; part_key?: string | null }[]) =>
  Object.assign(aMessage(), { filing_state: "filed", filings: filings.map((row) => ({ ticket_id: null, part_key: null, ...row })) });

function open(message: ReturnType<typeof aMessage>, over: Record<string, unknown> = {}) {
  const opened: number[] = [];
  const view = render(MessageAttribution, { message, plans, t: copyFor("zh"), onOpen: () => { opened.push(1); }, ...over });
  return { ...view, opened, chip: view.host.querySelector<HTMLButtonElement>(".attribution-chip")! };
}

test("a filed line is one tag: the job, the ticket after it; no editor and no second button", () => {
  const { host, chip, opened, close } = open(filed([{ task_id: "plan-a", ticket_id: "ticket-a" }]));
  try {
    expect(chip.querySelector(".plan")?.textContent).toBe("让审片员回复视频导演，说明未回复原因并给出审片意见。");
    expect(chip.querySelector(".detail")?.textContent).toBe("› 回复视频导演");
    expect(chip.getAttribute("aria-label")).toBe("归到：让审片员回复视频导演，说明未回复原因并给出审片意见。 · 回复视频导演 — 点击修改归属");
    expect(chip.title).toContain("归到：让审片员回复视频导演");
    expect(host.querySelectorAll("button")).toHaveLength(1);
    expect(host.querySelector("form, select, input")).toBeNull();
    click(chip);
    expect(opened).toHaveLength(1);
  } finally { close(); }
});

test("several jobs show the first and how many more, and every one in the tooltip", () => {
  const { chip, close } = open(filed([{ task_id: "plan-b" }, { task_id: "plan-a", part_key: "Shot 01–03" }]));
  try {
    expect(chip.querySelector(".plan")?.textContent).toBe("海报");
    expect(chip.querySelector(".more")?.textContent).toBe("另 1 件");
    expect(chip.title).toContain("海报 / 让审片员回复视频导演，说明未回复原因并给出审片意见。 · Shot 01–03");
  } finally { close(); }
});

test("a part shows after the ticket, and in English the same tag reads in English", () => {
  const { chip, close } = open(filed([{ task_id: "plan-a", ticket_id: "ticket-a", part_key: "Shot 02" }]), { t: copyFor("en") });
  try {
    expect(chip.querySelector(".detail")?.textContent).toBe("› 回复视频导演 · Shot 02");
    expect(chip.getAttribute("aria-label")).toContain("Filed under:");
    expect(chip.getAttribute("aria-label")).toContain("Click to change");
  } finally { close(); }
});

test("a line with no filing is a dashed tag that invites a choice", () => {
  const { chip, close } = open(Object.assign(aMessage(), { filing_state: "undetermined", filings: [] }));
  try {
    expect(chip.classList.contains("is-unfiled")).toBe(true);
    expect(chip.textContent?.replace(/\s+/g, " ").trim()).toBe("未归属 · 选择归属");
  } finally { close(); }
});

test("a job whose title has not loaded, or is gone, is 「一件事」, never its id", () => {
  const { chip, close } = open(filed([{ task_id: "01M3XDXJS58PDYSEWTPHA0AZJJ" }]), { plans: [] });
  try {
    expect(chip.textContent).toContain("一件事");
    expect(chip.textContent).not.toContain("01M3XDXJS58");
    expect(chip.getAttribute("aria-label")).not.toContain("01M3XDXJS58");
  } finally { close(); }
});

test("a disconnected or locked conversation shows the tag but does not open anything", () => {
  const { chip, opened, close } = open(filed([{ task_id: "plan-b" }]), { disabled: true });
  try {
    expect(chip.disabled).toBe(true);
    click(chip);
    expect(opened).toHaveLength(0);
  } finally { close(); }
});
