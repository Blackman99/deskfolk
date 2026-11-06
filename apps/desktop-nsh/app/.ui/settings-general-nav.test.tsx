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


const UPDATE = {
  current: "0.0.0",
  latest: "9.9.9",
  updateAvailable: true,
  releaseUrl: "https://example.com/releases/9.9.9",
  downloadUrl: "https://example.com/Deskfolk-9.9.9.dmg",
  publishedAt: null,
  notes: "### 新增\n\n- 第一条改动\n- 第二条改动\n\n### 修复\n\n- 修了一个问题\n",
};

test("the navigation lists every tab in order, marks the open one and opens another on a press", async () => {
  const { app } = await session();
  await app.press("id:story-show-nav");
  await app.waitFor("id:settings-nav");
  const order = ["general", "behavior", "interface", "models", "agents", "mcp", "prompts", "notifications", "lessons", "remote", "about"];
  for (const id of order) expect(app.shows(`id:settings-tab-${id}`)).toBe(true);
  for (const name of ["通用", "模型服务", "关于"]) expect(app.texts()).toContain(name);
  await app.press("id:settings-tab-models");
  await app.waitFor("text:active:models");
  await app.press("id:settings-tab-about");
  await app.waitFor("text:active:about");
  // A wide window has no ✕ in the sidebar: the dialog's own is the way out.
  expect(app.shows("id:settings-root-close")).toBe(false);
});

test("a tab carries an error mark, or the number of what it holds, in the warning colour when it conflicts", async () => {
  const { app } = await session();
  await app.press("id:story-show-nav");
  await app.waitFor("id:settings-nav");
  // The story says the general tab has an error and two edited prompts in conflict.
  expect(app.shows("id:settings-tab-general-error")).toBe(true);
  expect(app.shows("id:settings-tab-models-error")).toBe(false);
  await app.waitFor("id:settings-tab-prompts-count");
  expect(app.texts()).toContain("2");
  // The fixture has one endpoint and no MCP server.
  expect(app.shows("id:settings-tab-models-count")).toBe(true);
  expect(app.shows("id:settings-tab-mcp-count")).toBe(false);
});

test("on a phone the navigation is the whole page: a grouped list, and ✕ closes the dialog", async () => {
  const { app } = await session({}, 500);
  await app.press("id:story-show-nav");
  await app.waitFor("id:settings-root-close");
  expect(app.shows("id:settings-tab-general")).toBe(true);
  await app.press("id:settings-tab-mcp");
  await app.waitFor("text:active:mcp");
  await app.press("id:settings-root-close");
  await app.waitFor("text:log:close");
});

test("the About tab shows a dot while an update is waiting", async () => {
  const { app } = await session({ "tauri.check_for_update": () => UPDATE });
  await app.press("id:story-show-nav");
  await app.waitFor("id:settings-nav");
  expect(app.shows("id:settings-tab-about-dot")).toBe(false);
  await app.press("id:story-show-about");
  await app.press("id:about-check-update");
  await app.waitFor("id:about-update-banner");
  await app.press("id:story-show-nav");
  await app.waitFor("id:settings-tab-about-dot");
});

test("about: the name, description and version show, with the check button where the shell can ask", async () => {
  const { app } = await session();
  await app.press("id:story-show-about");
  await app.waitFor("id:about-version");
  expect(app.shows("text:Deskfolk")).toBe(true);
  // The shell answered `app_version`; the page shows what it said.
  await app.waitFor("text:版本 0.0.0");
  expect(app.shows("id:about-check-update")).toBe(true);
});

test("about: a check the shell cannot answer says so, and the button comes back", async () => {
  const { app } = await session();
  await app.press("id:story-show-about");
  await app.press("id:about-check-update");
  await app.waitFor("id:about-update-failed");
  expect(app.texts()).toContain("没能检查更新。");
  expect(app.enabled("id:about-check-update")).toBe(true);
  expect(app.shows("id:about-up-to-date")).toBe(false);
});

test("about: up to date says so", async () => {
  const { app } = await session({ "tauri.check_for_update": () => ({ ...UPDATE, latest: "0.0.0", updateAvailable: false }) });
  await app.press("id:story-show-about");
  await app.press("id:about-check-update");
  await app.waitFor("id:about-up-to-date");
  expect(app.texts()).toContain("已是最新版本。");
  expect(app.shows("id:about-update-banner")).toBe(false);
});

test("about: an update lists what changed and offers download, notes and ignore", async () => {
  const { app } = await session({ "tauri.check_for_update": () => UPDATE });
  await app.press("id:story-show-about");
  await app.press("id:about-check-update");
  await app.waitFor("id:about-update-banner");
  expect(app.texts()).toContain("有新版本 9.9.9 可用。");
  for (const text of ["这一版改了什么", "新增", "第一条改动", "第二条改动", "修复", "修了一个问题"]) expect(app.texts()).toContain(text);
  // This copy cannot replace itself (the shell does not say it can): no in-app install, the browser download is primary.
  expect(app.shows("id:about-update-install")).toBe(false);
  await app.press("id:about-update-download");
  await app.waitUntil(() => app.openedUrls().includes(UPDATE.downloadUrl));
  await app.press("id:about-update-notes");
  await app.waitUntil(() => app.openedUrls().includes(UPDATE.releaseUrl));
  await app.press("id:about-update-ignore");
  await app.waitFor("id:about-update-ignore", { state: "gone" });
  expect(app.shows("id:about-update-banner")).toBe(true);
});

test("about: where the shell can install in place, the install shows its progress and can be cancelled", async () => {
  let started = false;
  let cancelled = false;
  const { app } = await session({
    "tauri.check_for_update": () => UPDATE,
    "tauri.can_install_update": true,
    "tauri.update_install_state": () => (started && !cancelled ? { phase: "downloading", downloaded: 1048576, total: 4194304, version: "9.9.9", error: null, detail: null } : { phase: "idle" }),
    "tauri.start_update_install": () => {
      started = true;
      return { phase: "downloading", downloaded: 1048576, total: 4194304, version: "9.9.9", error: null, detail: null };
    },
    "tauri.cancel_update_install": () => {
      cancelled = true;
      return { phase: "idle" };
    },
  });
  await app.press("id:story-show-about");
  await app.press("id:about-check-update");
  await app.waitFor("id:about-update-install");
  expect(app.texts()).toContain("在应用内下载，装好自动重启，不用再过一遍安装器。");
  await app.press("id:about-update-install");
  await app.waitFor("id:about-install");
  expect(app.texts()).toContain("正在下载");
  expect(app.texts()).toContain("1.0 MB / 4.0 MB");
  expect(app.shows("id:about-update-install")).toBe(false);
  await app.press("id:about-install-cancel");
  await app.waitFor("id:about-install", { state: "gone" });
  await app.waitFor("id:about-update-install");
});

test("about: a failed install says why and offers a retry", async () => {
  const { app } = await session({
    "tauri.check_for_update": () => UPDATE,
    "tauri.can_install_update": true,
    "tauri.start_update_install": () => {
      throw new Error("read-only");
    },
  });
  await app.press("id:story-show-about");
  await app.press("id:about-check-update");
  await app.waitFor("id:about-update-install");
  await app.press("id:about-update-install");
  await app.waitFor("id:about-install-failed");
  await app.waitFor("id:about-update-install");
  expect(app.shows("id:about-install-failed")).toBe(true);
});
