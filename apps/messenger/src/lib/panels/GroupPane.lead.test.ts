import { expect, test } from "bun:test";
import { flushSync } from "svelte";
import type { GroupLeadState } from "@real-bot/protocol";
import { copyFor } from "../copy.ts";
import { aBot, aGroup, fakeRuntime } from "../test-fixtures.ts";
import { click, render } from "../test-render.ts";
import { reactive } from "../test-reactive.svelte.ts";
import GroupPane from "./GroupPane.svelte";
import type { GroupDetailDraft } from "./group-edit.ts";

const t = copyFor("zh");
const session = aGroup();
const suggestionState: GroupLeadState = {
  session_id: session.id,
  confirmed_bot_id: null,
  suggestion: { bot_id: "bot-1", handoffs: 8, since: "2026-09-12T00:00:00Z" },
};

function open(state: GroupLeadState | null, stubs: Record<string, unknown> = {}, bots = [aBot({ name: "导演" }), aBot({ id: "bot-2", name: "审片员" })]) {
  const plain = fakeRuntime({ bots, sessions: [session] }, stubs);
  const runtime = reactive(plain);
  if (state) runtime.groupLeads = { [session.id]: state };
  const detail = reactive({ sessionId: session.id, name: "视频组", nameError: undefined, failed: false, pullPick: "" }) as GroupDetailDraft;
  const view = render(GroupPane, { runtime, selected: session, t, detail, onOpenProfile: () => {}, onDeleteGroup: () => {}, onClearHistory: () => {} });
  const row = (name: string): HTMLElement => {
    const found = [...view.host.querySelectorAll<HTMLElement>(".member")].find((el) => el.querySelector(".member-name-btn")?.textContent?.trim().startsWith(name));
    if (!found) throw new Error(`no member row for ${name}`);
    return found;
  };
  const leadButton = (name: string): HTMLButtonElement | null => row(name).querySelector<HTMLButtonElement>(".btn-lead");
  const confirms = () => plain.calls.filter((call) => call.name === "confirmGroupLead");
  return { ...view, runtime, plain, row, leadButton, confirms };
}

test("opening the member list loads the lead; a suggestion sits on that member's row and never sets anything", () => {
  const { plain, row, leadButton, confirms, close } = open(suggestionState);
  try {
    expect(plain.calls.some((call) => call.name === "loadGroupLead" && call.args[0] === session.id)).toBe(true);
    expect(row("导演").textContent).toContain(t.groupLead.suggested(8));
    expect(row("审片员").textContent).not.toContain("建议");
    expect(leadButton("导演")?.classList.contains("is-suggested")).toBe(true);
    expect(leadButton("审片员")?.classList.contains("is-suggested")).toBe(false);
    expect(confirms()).toHaveLength(0);
  } finally { close(); }
});

test("one click on a member's row sets the lead; the same button on the lead takes it back", async () => {
  const { host, runtime, row, leadButton, confirms, close } = open(suggestionState);
  try {
    expect(host.textContent).toContain(t.groupLead.unconfirmed);
    expect(host.querySelector(".member-badge.is-lead")).toBeNull();
    click(leadButton("审片员"));
    await Promise.resolve(); flushSync();
    expect(confirms().map((call) => call.args)).toEqual([[session.id, "bot-2"]]);

    // The daemon's answer arrives as group_lead.changed.
    runtime.groupLeads = { [session.id]: { ...suggestionState, confirmed_bot_id: "bot-2" } }; flushSync();
    expect(row("审片员").querySelector(".member-badge.is-lead")?.textContent).toBe(t.groupLead.badge);
    expect(row("导演").querySelector(".member-badge.is-lead")).toBeNull();
    expect(leadButton("审片员")?.textContent?.trim()).toBe(t.groupLead.clear);
    expect(leadButton("导演")?.textContent?.trim()).toBe(t.groupLead.set);
    expect(host.textContent).toContain(t.groupLead.confirmed);

    click(leadButton("审片员"));
    await Promise.resolve(); flushSync();
    expect(confirms().at(-1)?.args).toEqual([session.id, null]);
  } finally { close(); }
});

test("a lead that failed to save says so and leaves the buttons usable", async () => {
  const saves: unknown[][] = [];
  const { host, leadButton, close } = open(suggestionState, { confirmGroupLead: (...args: unknown[]) => { saves.push(args); return Promise.resolve(new Error("refused")); } });
  try {
    click(leadButton("导演"));
    await Promise.resolve(); flushSync();
    expect(host.textContent).toContain(t.groupLead.failed);
    expect(leadButton("导演")?.disabled).toBe(false);
    click(leadButton("导演"));
    await Promise.resolve(); flushSync();
    expect(saves).toEqual([[session.id, "bot-1"], [session.id, "bot-1"]]);
  } finally { close(); }
});

test("an archived Bot is not offered for lead, but the lead itself can always be cleared", () => {
  const bots = [aBot({ name: "导演" }), aBot({ id: "bot-2", name: "审片员", archived_at: "2026-09-20T00:00:00Z" })];
  const archivedLead = open({ session_id: session.id, confirmed_bot_id: "bot-2", suggestion: null }, {}, bots);
  try {
    expect(archivedLead.leadButton("导演")?.textContent?.trim()).toBe(t.groupLead.set);
    expect(archivedLead.leadButton("审片员")?.textContent?.trim()).toBe(t.groupLead.clear);
  } finally { archivedLead.close(); }
  const plain = open(null, {}, bots);
  try {
    plain.runtime.groupLeads = { [session.id]: { session_id: session.id, confirmed_bot_id: null, suggestion: null } }; flushSync();
    expect(plain.leadButton("审片员")).toBeNull();
    expect(plain.leadButton("导演")).not.toBeNull();
  } finally { plain.close(); }
});

test("nothing is offered before the lead loads, or from a daemon that has no lead endpoint", () => {
  const loading = open(null);
  try {
    expect(loading.leadButton("导演")).toBeNull();
    expect(loading.host.textContent).not.toContain(t.groupLead.unconfirmed);
  } finally { loading.close(); }
  const unsupported = open(suggestionState);
  try {
    unsupported.runtime.groupLeadUnsupported = { [session.id]: true }; flushSync();
    expect(unsupported.leadButton("导演")).toBeNull();
    expect(unsupported.host.textContent).not.toContain(t.groupLead.unconfirmed);
  } finally { unsupported.close(); }
});

test("a lead that could not be loaded offers a retry", () => {
  const { host, runtime, plain, close } = open(null);
  try {
    runtime.groupLeadLoadError = { [session.id]: true }; flushSync();
    expect(host.textContent).toContain(t.groupLead.loadFailed);
    const before = plain.calls.filter((call) => call.name === "loadGroupLead").length;
    click(host.querySelector(".lead-retry"));
    expect(plain.calls.filter((call) => call.name === "loadGroupLead").length).toBe(before + 1);
  } finally { close(); }
});

test("an English interface reads the same flow in English", () => {
  const en = copyFor("en");
  const plain = fakeRuntime({ bots: [aBot({ name: "Director" }), aBot({ id: "bot-2", name: "Reviewer" })], sessions: [session] });
  const runtime = reactive(plain);
  runtime.groupLeads = { [session.id]: { ...suggestionState, confirmed_bot_id: "bot-2" } };
  const detail = reactive({ sessionId: session.id, name: "Video", nameError: undefined, failed: false, pullPick: "" }) as GroupDetailDraft;
  const { host, close } = render(GroupPane, { runtime, selected: session, t: en, detail, onOpenProfile: () => {}, onDeleteGroup: () => {}, onClearHistory: () => {} });
  try {
    expect(host.querySelector(".member-badge.is-lead")?.textContent).toBe("Lead");
    expect(host.textContent).toContain("Remove lead");
    expect(host.textContent).toContain("Make lead");
  } finally { close(); }
});
