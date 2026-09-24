import { expect, test } from "bun:test";
import { flushSync } from "svelte";
import { copyFor, thinkingLevelLabel } from "../copy.ts";
import { reactive } from "../test-reactive.svelte.ts";
import { buttonByText, click, fill, press, render } from "../test-render.ts";
import ProviderForm from "./ProviderForm.svelte";
import { emptyModelAttr, emptyProviderDraft, type ProviderDraft } from "./provider-form.ts";

const t = copyFor("zh");
const settle = async () => {
  await new Promise((r) => setTimeout(r, 0));
  flushSync();
};

const NAMES = ["grok-4.6", "gemini-3.8-flash", "claude-opus-5", "a-very-long-model-name-that-wraps-on-a-phone"];

function listed(enabled = ["grok-4.6"]): ProviderDraft {
  return {
    ...emptyProviderDraft(),
    name: "Default",
    baseUrl: "https://api.example.com/v1",
    models: [...enabled],
    availableModels: [...NAMES],
    defaultModel: enabled[0] ?? "",
    modelAttrs: Object.fromEntries(enabled.map((name) => [name, emptyModelAttr()])),
  };
}

function phoneMedia(): () => void {
  const previous = window.matchMedia;
  window.matchMedia = ((query: string) => ({
    matches: query === "(max-width: 720px)",
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  })) as typeof window.matchMedia;
  return () => {
    window.matchMedia = previous;
  };
}

function open(draft: ProviderDraft, over: { fetchError?: string | null; fetching?: boolean } = {}) {
  const restore = phoneMedia();
  const state = reactive({
    draft,
    detailModel: null as string | null,
    fetchError: over.fetchError ?? null,
    fetching: over.fetching ?? false,
  });
  const view = render(ProviderForm, {
    get draft() {
      return state.draft;
    },
    errors: {},
    failed: false,
    get fetching() {
      return state.fetching;
    },
    get fetchError() {
      return state.fetchError;
    },
    fieldPrefix: "provider-prov-1",
    keySet: true,
    view: "models",
    get detailModel() {
      return state.detailModel;
    },
    set detailModel(value: string | null) {
      state.detailModel = value;
    },
    t,
    onchange: (next: ProviderDraft) => {
      state.draft = next;
    },
    onfetch: () => {},
  });
  return {
    ...view,
    state,
    close: () => {
      view.close();
      restore();
    },
  };
}

function rowNames(host: HTMLElement): string[] {
  return [...host.querySelectorAll<HTMLButtonElement>(".model-row-toggle")].map(
    (row) => row.getAttribute("aria-label") ?? "",
  );
}

function rowByName(host: HTMLElement, name: string): HTMLButtonElement {
  const row = [...host.querySelectorAll<HTMLButtonElement>(".model-row-toggle")].find(
    (item) => item.getAttribute("aria-label") === name,
  );
  if (!row) throw new Error(`no model row ${name}`);
  return row;
}

test("phone search filters the list and clear brings every row back", () => {
  const { host, close } = open(listed());
  expect(host.querySelector(".model-picker-toolbar")).toBeTruthy();
  fill(host.querySelector(".model-picker-search"), "opus");
  expect(rowNames(host)).toEqual(["claude-opus-5"]);
  expect(host.querySelector(".model-search-clear")).toBeTruthy();
  click(host.querySelector(".model-search-clear"));
  expect((host.querySelector(".model-picker-search") as HTMLInputElement).value).toBe("");
  expect(rowNames(host)).toEqual(NAMES);
  close();
});

test("all and enabled filters keep the search and an empty enabled list says so", () => {
  const { host, state, close } = open(listed(["grok-4.6", "claude-opus-5"]));
  fill(host.querySelector(".model-picker-search"), "a");
  click(buttonByText(host, `${t.settings.modelsFilterEnabled} 2`));
  expect(rowNames(host)).toEqual(["claude-opus-5"]);
  click(buttonByText(host, `${t.settings.modelsFilterAll} 4`));
  expect(rowNames(host)).toEqual(["gemini-3.8-flash", "claude-opus-5", NAMES[3]!]);
  click(host.querySelector(".model-search-clear"));
  flushSync(() => {
    state.draft = listed([]);
  });
  click(buttonByText(host, `${t.settings.modelsFilterEnabled} 0`));
  expect(rowNames(host)).toEqual([]);
  expect(host.textContent).toContain(t.settings.modelsEnabledEmpty);
  close();
});

test("select and clear after a search only change the visible rows", () => {
  const { host, state, close } = open(listed(["grok-4.6"]));
  fill(host.querySelector(".model-picker-search"), "flash");
  click(buttonByText(host, t.settings.modelsSelectVisible));
  expect(state.draft.models).toEqual(["grok-4.6", "gemini-3.8-flash"]);
  expect(rowNames(host)).toEqual(["gemini-3.8-flash"]);
  click(buttonByText(host, t.settings.modelsClearVisible));
  expect(state.draft.models).toEqual(["grok-4.6"]);
  expect(rowByName(host, "gemini-3.8-flash").getAttribute("aria-checked")).toBe("false");
  close();
});

test("a long name stays on its row and a hand-typed name clears the search", () => {
  const { host, state, close } = open(listed());
  fill(host.querySelector(".model-picker-search"), "wraps");
  const name = host.querySelector(".model-row-name");
  expect(name?.textContent).toBe(NAMES[3]);
  expect(getComputedStyle(name!).whiteSpace).not.toBe("nowrap");
  click(buttonByText(host, `+ ${t.settings.modelsAddManual}`));
  const field = host.querySelector(".model-manual-input");
  fill(field, `  ${NAMES[3]}  `);
  press(field, "Enter");
  expect(state.draft.models).toEqual(["grok-4.6", NAMES[3]]);
  expect((host.querySelector(".model-picker-search") as HTMLInputElement).value).toBe("");
  expect(host.textContent).toContain(t.settings.modelsManualAdded(NAMES[3]!));
  expect(rowNames(host)).toEqual(NAMES);
  close();
});

test("adding a name that is already enabled only says so, and cancel drops the field", () => {
  const { host, state, close } = open(listed());
  click(buttonByText(host, `+ ${t.settings.modelsAddManual}`));
  const field = host.querySelector(".model-manual-input");
  fill(field, "grok-4.6");
  click(buttonByText(host, t.settings.modelsAddConfirm));
  expect(state.draft.models).toEqual(["grok-4.6"]);
  expect(host.querySelector(".model-manual-feedback")?.textContent).toBe(t.settings.modelsAlreadyEnabled);
  click(buttonByText(host, t.sidebar.cancel));
  expect(host.querySelector(".model-manual-input")).toBeNull();
  expect(host.querySelector(".model-manual-feedback")).toBeNull();
  close();
});

test("attributes open their own page and back keeps the search and the selection", async () => {
  const { host, state, app, close } = open(listed(["grok-4.6", "gemini-3.8-flash"]));
  fill(host.querySelector(".model-picker-search"), "grok");
  const attrs = [...host.querySelectorAll<HTMLButtonElement>(".model-row-attrs")].find((button) =>
    button.getAttribute("aria-label")?.includes("grok-4.6"),
  );
  click(attrs);
  expect(state.detailModel).toBe("grok-4.6");
  expect(host.querySelector(".model-attributes-page")).toBeTruthy();
  expect(host.querySelector(".model-attributes-name")?.textContent).toBe("grok-4.6");
  expect(host.querySelector(".model-list-section")?.classList.contains("has-detail")).toBe(true);
  expect((app as unknown as { backFromDetails(): boolean }).backFromDetails()).toBe(true);
  flushSync();
  await settle();
  expect(state.detailModel).toBeNull();
  expect(host.querySelector(".model-attributes-page")).toBeNull();
  expect((host.querySelector(".model-picker-search") as HTMLInputElement).value).toBe("grok");
  expect(rowNames(host)).toEqual(["grok-4.6"]);
  expect(state.draft.models).toEqual(["grok-4.6", "gemini-3.8-flash"]);
  close();
});

test("a custom thinking level and a price land on that model's attributes", () => {
  const { host, state, close } = open(listed());
  click(host.querySelector(".model-row-attrs"));
  const page = host.querySelector(".model-attributes-page")!;
  fill(page.querySelector(".attr-price-input"), "1.5");
  expect(state.draft.modelAttrs["grok-4.6"]?.price).toBe("1.5");
  click(buttonByText(page as HTMLElement, `+ ${t.settings.modelThinkingAdd}`));
  const field = page.querySelector(".chip-input");
  fill(field, "xhigh");
  press(field, "Enter");
  expect(state.draft.modelAttrs["grok-4.6"]?.thinkingLevels).toEqual(["none", "low", "medium", "high", "xhigh"]);
  expect(page.textContent).toContain(thinkingLevelLabel(t.sidebar.thinkingLevels, "xhigh"));
  close();
});

test("an empty list explains itself and a fetch error stays on the page", () => {
  const empty = open({ ...listed([]), availableModels: [] });
  expect(empty.host.querySelector(".model-picker-empty")?.textContent).toContain(t.settings.modelsAutoFetchHint);
  expect(empty.host.querySelector(".model-picker-toolbar")).toBeNull();
  empty.close();

  const failed = open({ ...listed([]), availableModels: [] }, { fetchError: `${t.settings.modelsFetchFailed} (down)` });
  expect(failed.host.querySelector(".models-fetch-tip")?.textContent).toContain("down");
  expect(failed.host.querySelector(".model-picker-empty")?.textContent).toContain(t.settings.modelsEmptyHint);
  failed.close();

  const fetching = open({ ...listed([]), availableModels: [] }, { fetching: true });
  expect(fetching.host.querySelector(".model-picker-empty")?.textContent).toContain(t.settings.modelsFetchingHint);
  fetching.close();
});

test("phone billing attributes accept both rates, retain the draft and clear together", async () => {
  const { host, state, close, component } = open(listed());
  click(host.querySelector(".model-row-attrs"));
  const input = host.querySelector<HTMLInputElement>('[id*="-billingInput-"]');
  expect(input).toBeTruthy();
  fill(input, "2.5");
  expect(host.textContent).toContain(t.settings.modelBillingInvalid);
  fill(host.querySelector('[id*="-billingOutput-"]'), "8");
  fill(host.querySelector('[id*="-billingCachedInput-"]'), "0.25");
  expect(state.draft.modelAttrs["grok-4.6"]).toMatchObject({ billingInput: "2.5", billingOutput: "8", billingCachedInput: "0.25" });
  expect(host.textContent).not.toContain(t.settings.modelBillingInvalid);
  click(buttonByText(host, t.settings.modelBillingClear));
  expect(state.draft.modelAttrs["grok-4.6"]).toMatchObject({ billingInput: "", billingOutput: "", billingCachedInput: "" });
  close();
});
