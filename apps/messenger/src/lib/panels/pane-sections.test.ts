import { expect, test } from "bun:test";
import { flushSync } from "svelte";
import { copyFor } from "../copy.ts";
import { aBot, aBotDirect, aGroup, aSkill, fakeRuntime } from "../test-fixtures.ts";
import { reactive } from "../test-reactive.svelte.ts";
import { click, render } from "../test-render.ts";
import GroupPane from "./GroupPane.svelte";
import ProfilePane from "./ProfilePane.svelte";

const t = copyFor("en");

/** The panes read the same 680px breakpoint the stylesheet does; happy-dom answers no by default. */
function withPhone(run: () => void): void {
  const previous = window.matchMedia;
  window.matchMedia = ((query: string) => ({
    matches: query === "(max-width: 680px)",
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  })) as typeof window.matchMedia;
  try {
    run();
  } finally {
    window.matchMedia = previous;
  }
}

function openProfile() {
  const bot = aBot({ id: "bot-1", name: "Researcher" });
  const runtime = reactive(fakeRuntime({ bots: [bot], skills: [aSkill()] }, { profileBotId: "bot-1" }));
  const rendered = render(ProfilePane, {
    runtime,
    bot,
    t,
    modelOptions: [],
    selectedKind: "you-bot",
    profileFailed: false,
    openDangerConfirm: () => {},
    clearDanger: () => {},
    onDeleteBot: () => {},
    onClearHistory: () => {},
  } as never);
  return { ...rendered, runtime };
}

function openGroup(session = aGroup({ id: "sess-1" })) {
  const runtime = reactive(fakeRuntime({ bots: [aBot({ id: "bot-1" }), aBot({ id: "bot-2" })], sessions: [session] }));
  const detail = reactive({ sessionId: session.id, name: "Video", nameError: undefined, failed: false, pullPick: "" });
  const rendered = render(GroupPane, {
    runtime,
    selected: session,
    t,
    detail,
    onOpenProfile: () => {},
    onDeleteGroup: () => {},
    onClearHistory: () => {},
  } as never);
  return { ...rendered, runtime };
}

test("a phone row's count sits against the chevron, not in the middle of the row", () => {
  withPhone(() => {
    const setViewport = (window as unknown as { happyDOM: { setViewport: (v: { width: number; height: number }) => void } }).happyDOM.setViewport.bind(
      (window as unknown as { happyDOM: { setViewport: (v: { width: number; height: number }) => void } }).happyDOM,
    );
    setViewport({ width: 390, height: 844 });
    try {
      const { host, close } = openProfile();
      const skills = host.querySelectorAll<HTMLButtonElement>(".bot-tab-btn")[1]!;
      const name = getComputedStyle(skills.querySelector(".tab-name")!);
      const count = getComputedStyle(skills.querySelector(".tab-count")!);
      const chevron = getComputedStyle(skills.querySelector(".tab-chevron")!);
      // The name grows into the free space. A count with its own auto margin used to split that
      // space with the chevron and park the number in the middle of the row.
      expect(name.flexGrow).toBe("1");
      expect(name.textAlign).toBe("left");
      expect(count.marginLeft).toBe("8px");
      expect(chevron.display).toBe("block");
      expect(chevron.marginLeft).toBe("8px");
      close();
    } finally {
      setViewport({ width: 1024, height: 768 });
    }
  });
});

test("the section tabs sit flush under the title on a wide window", () => {
  const { host, close } = openProfile();
  const nav = getComputedStyle(host.querySelector(".bot-nav-sticky")!);
  const tabs = getComputedStyle(host.querySelector(".bot-tabs")!);
  const active = getComputedStyle(host.querySelector(".bot-tab-btn.is-active")!);
  expect(nav.paddingTop).toBe("0px");
  expect(nav.paddingRight).toBe("0px");
  expect(nav.paddingBottom).toBe("0px");
  expect(nav.paddingLeft).toBe("0px");
  expect(tabs.paddingTop).toBe("0px");
  expect(tabs.borderTopWidth).toBe("0px");
  expect(tabs.borderRadius).toBe("0px");
  expect(active.borderBottomWidth).toBe("2px");
  expect(active.boxShadow).toBe("none");
  close();
});

test("a Bot's sections are a list on a phone, and a row opens that section", () => {
  withPhone(() => {
    const { host, close } = openProfile();
    const pane = host.querySelector(".profile-pane");
    expect(pane?.classList.contains("is-mobile-detail")).toBe(false);
    const rows = [...host.querySelectorAll<HTMLButtonElement>(".bot-tab-btn")];
    expect(rows.map((row) => row.textContent?.replace(/\s+/g, " ").trim())).toEqual([
      t.detail.botTabBasics,
      `${t.detail.botTabSkills} 1`,
      t.detail.botTabRoutines,
      t.detail.botTabMemory,
      t.detail.botTabActions,
    ]);
    click(rows[1]);
    expect(pane?.classList.contains("is-mobile-detail")).toBe(true);
    expect(host.querySelector(".bot-detail-title")?.textContent).toBe(t.detail.botTabSkills);
    click(host.querySelector(".bot-detail-back"));
    expect(pane?.classList.contains("is-mobile-detail")).toBe(false);
    close();
  });
});

test("the row of the section already shown still opens it", () => {
  withPhone(() => {
    const { host, close } = openProfile();
    // Basics is the tab in the wider layout, so its row must not be a no-op on a phone.
    click(host.querySelector(".bot-tab-btn"));
    expect(host.querySelector(".profile-pane")?.classList.contains("is-mobile-detail")).toBe(true);
    expect(host.querySelector(".bot-detail-title")?.textContent).toBe(t.detail.botTabBasics);
    close();
  });
});

test("a group's sections are a list, and only the open one is rendered", () => {
  withPhone(() => {
    const { host, close } = openGroup();
    const rows = [...host.querySelectorAll<HTMLButtonElement>(".group-section-btn")];
    expect(rows.map((row) => row.textContent?.replace(/\s+/g, " ").trim())).toEqual([
      `${t.detail.members} 3`,
      t.detail.sessionActions,
      t.detail.dangerZone,
    ]);
    // The list screen alone: none of the cards are mounted behind it.
    expect(host.querySelector(".group-members-card")).toBeNull();
    click(rows[0]);
    flushSync();
    expect(host.querySelector(".group-detail-title")?.textContent).toBe(t.detail.members);
    expect(host.querySelector(".group-members-card")).not.toBeNull();
    expect(host.querySelector(".danger-zone-card")).toBeNull();
    click(host.querySelector(".group-detail-back"));
    flushSync();
    expect(host.querySelector(".group-members-card")).toBeNull();
    close();
  });
});

test("a Bot-to-Bot session lists only the sections it has", () => {
  withPhone(() => {
    const { host, close } = openGroup(aBotDirect({ id: "botbot-1" }));
    const rows = [...host.querySelectorAll<HTMLButtonElement>(".group-section-btn")];
    expect(rows.map((row) => row.textContent?.replace(/\s+/g, " ").trim())).toEqual([
      `${t.detail.members} 2`,
      t.detail.dangerZone,
    ]);
    close();
  });
});

test("wider windows keep one scrolling column with every card and no section list", () => {
  const { host, close } = openGroup();
  expect(host.querySelector(".group-members-card")).not.toBeNull();
  expect(host.querySelector(".danger-zone-card")).not.toBeNull();
  // The list and the section header exist in the markup but are the phone layout's business.
  expect(host.querySelector(".group-pane")?.classList.contains("is-mobile-detail")).toBe(false);
  close();
});

test("✕ in the drawer closes the section, not the drawer", () => {
  withPhone(() => {
    // The pane owns the section; the shell's ✕ is tested with the shell.
    const { host, close } = openProfile();
    click(host.querySelectorAll<HTMLButtonElement>(".bot-tab-btn")[2]);
    expect(host.querySelector(".profile-pane")?.classList.contains("is-mobile-detail")).toBe(true);
    click(host.querySelector(".bot-detail-back"));
    expect(host.querySelector(".profile-pane")?.classList.contains("is-mobile-detail")).toBe(false);
    close();
  });
});
