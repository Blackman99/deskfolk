import { expect, open, test } from "nsh/test";
import { seeded } from "./fixture";

type Api = {
  seq: number;
  theme: string;
  locale: string;
  launch: boolean;
  mode: string | null;
  workspace: string;
  speech: Record<string, unknown> | null;
  builtin: Record<string, unknown> | null;
  botModes: Record<string, string | null>;
};
type App = Awaited<ReturnType<typeof openGeneral>>;

/** What the runtime itself says (a GET the story makes), not what the page draws. */
async function readApi(app: App, last: { seq: number }): Promise<Api> {
  await app.press("id:api-refresh");
  const find = () => app.texts().find((text) => text.startsWith('{"seq":'));
  await app.waitUntil(() => {
    const text = find();
    return text !== undefined && (JSON.parse(text) as Api).seq > last.seq;
  });
  const got = JSON.parse(find()!) as Api;
  last.seq = got.seq;
  return got;
}

/** The story on the fixture's runtime, with the shell commands the settings pages call answered as given. */
async function openGeneral(handlers: Record<string, unknown> = {}, width = 1100) {
  const endpoint = { origin: seeded.origin, token: seeded.token };
  const app = await open("../Story.tsx", {
    platform: "macos",
    width,
    height: 900,
    locale: "zh-CN",
    network: "live",
    host: {
      params: { ...endpoint, windowId: 1, material: "none", story: "settings-general" },
      handlers: {
        "tauri.local_api_endpoint": endpoint,
        "tauri.app_version": "0.0.0",
        "tauri.window_material": "none",
        "tauri.set_launch_at_login": true,
        ...handlers,
      },
    },
  });
  await app.waitFor("id:settings-general", { timeout: 15_000 });
  return app;
}

/** The story, with a reader of the runtime's own state and a way back to what the fixture had. */
async function session(handlers: Record<string, unknown> = {}, width = 1100) {
  const app = await openGeneral(handlers, width);
  const last = { seq: 0 };
  const read = () => readApi(app, last);
  await read();
  /** Reads again until `check` holds: a save lands after the press that made it. */
  const until = async (check: (api: Api) => boolean, what: string): Promise<Api> => {
    for (let i = 0; i < 40; i++) {
      const got = await read();
      if (check(got)) return got;
      await app.wait(150);
    }
    throw new Error(`never became true: ${what}`);
  };
  const restore = async () => {
    await app.press("id:story-restore");
    await app.wait(500);
  };
  return { app, read, until, restore };
}

test("the workspace card shows the folder as set, with the role note, and a chosen folder is saved", async () => {
  const target = "/tmp";
  const { app, read, until, restore } = await session({ "tauri.pick_workspace_folder": target });
  try {
    const before = await read();
    expect(app.shows("text:已配置")).toBe(true);
    expect(app.texts()).toContain(before.workspace);
    expect(app.shows("text:工作区的用途")).toBe(true);
    await app.press("id:workspace-choose");
    await until((api) => api.workspace.endsWith(target), "workspace saved");
    await app.waitUntil(() => app.texts().some((text) => text.endsWith(target)));
    expect(app.host.calls().some((call) => call.name === "tauri.pick_workspace_folder")).toBe(true);
  } finally {
    await restore();
  }
});

test("the theme pills write the theme they name", async () => {
  const { app, until, restore } = await session();
  try {
    await app.press("id:theme-dark");
    await until((api) => api.theme === "dark", "theme dark");
    await app.press("id:theme-light");
    await until((api) => api.theme === "light", "theme light");
  } finally {
    await restore();
  }
});

test("the language pills switch the interface language and save it", async () => {
  const { app, until, restore } = await session();
  try {
    await app.press("id:locale-en");
    await until((api) => api.locale === "en", "locale en");
    await app.waitFor("text:Appearance");
    expect(app.shows("text:Permission mode")).toBe(true);
  } finally {
    await restore();
  }
});

test("focus mode is kept in this browser, and launch at login saves and asks the shell", async () => {
  const { app, read, until, restore } = await session();
  try {
    const before = await read();
    await app.press("id:focus-mode-toggle");
    await app.waitFor("text:focus:on");
    await app.press("id:focus-mode-toggle");
    await app.waitFor("text:focus:off");

    await app.press("id:launch-at-login-toggle");
    await until((api) => api.launch === !before.launch, "launch flipped");
    await app.waitUntil(() => app.host.calls().some((call) => call.name === "tauri.set_launch_at_login"));
  } finally {
    await restore();
  }
});

test("the independent runtime switch is disabled while gated and says why", async () => {
  const { app } = await session();
  await app.waitFor("id:independent-reason");
  expect(app.texts()).toContain("原因：gated");
  expect(app.enabled("id:independent-runtime-toggle")).toBe(false);
});

test("the permission mode card marks the saved mode, saves a pick, and names the Bots that chose their own", async () => {
  const { app, until, restore } = await session();
  try {
    await app.waitFor("id:permission-mode-auto");
    expect(app.shows("text:默认")).toBe(true);
    expect(app.shows("id:permission-overrides")).toBe(false);
    await app.press("id:permission-mode-ask_first");
    await until((api) => api.mode === "ask_first", "mode saved");
    // A Bot with its own mode is named under the card.
    await app.press("id:story-bot-mode");
    await app.waitFor("id:permission-overrides");
    expect(app.texts().some((text) => text.includes("Writer") && text.includes("只读"))).toBe(true);
  } finally {
    await restore();
  }
});

test("a narrow window still shows the segmented controls", async () => {
  const { app } = await session({}, 480);
  expect(app.shows("id:theme-system")).toBe(true);
  expect(app.shows("id:locale-zh")).toBe(true);
});

test("behavior: a kind's placement changes, is marked, and Back to defaults clears it", async () => {
  const { app } = await session();
  await app.press("id:story-show-behavior");
  await app.waitFor("id:open-placement-reset");
  expect(app.enabled("id:open-placement-reset")).toBe(false);
  expect(app.shows("id:open-placement-changed-routines")).toBe(false);
  await app.press("id:open-placement-select-routines");
  await app.press("text:向右分屏");
  await app.waitFor("id:open-placement-changed-routines");
  expect(app.enabled("id:open-placement-reset")).toBe(true);
  await app.press("id:open-placement-reset");
  await app.waitFor("id:open-placement-changed-routines", { state: "gone" });
  expect(app.enabled("id:open-placement-reset")).toBe(false);
});

test("a hosted shell shows the folder as text, not a picker, and a refused path is named", async () => {
  const { app } = await session();
  await app.press("id:story-ws-error");
  await app.waitFor("id:workspace-error");
  expect(app.texts()).toContain("选择一个本机目录。");
  await app.press("id:story-readonly");
  await app.waitFor("id:workspace-readonly-path");
  expect(app.shows("id:workspace-choose")).toBe(false);
  expect(app.shows("text:工作区根目录只在本机窗口里改，远控不能改。")).toBe(true);
});
