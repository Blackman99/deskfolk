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


test("the models page opens on the endpoints tab, the caller's slot and notices show, and the speech tab shows its card", async () => {
  const { app } = await session();
  await app.press("id:story-show-models");
  await app.waitFor("id:models-tab-endpoints");
  expect(app.shows("id:models-endpoints")).toBe(true);
  expect(app.shows("id:models-notice")).toBe(true);
  expect(app.shows("id:speech-settings")).toBe(false);
  // The endpoints tab carries the number of endpoints the fixture has.
  expect(app.shows("id:models-tab-endpoints-count")).toBe(true);
  await app.press("id:models-tab-speech");
  await app.waitFor("id:speech-settings");
  expect(app.shows("id:models-intro")).toBe(true);
  expect(app.shows("id:models-endpoints")).toBe(false);
  expect(app.shows("id:speech-service")).toBe(true);
});

test("a speech service fills in its address and model; the key is saved when you leave it and never shown", async () => {
  const { app, until, restore } = await session();
  try {
    await app.press("id:story-show-models");
    await app.press("id:models-tab-speech");
    await app.waitFor("id:speech-service");
    await app.press("id:speech-service");
    await app.press("text:硅基流动");
    const got = await until((api) => api.speech?.preset === "siliconflow", "preset saved");
    expect(got.speech).toMatchObject({ format: "openai", base_url: "https://api.siliconflow.cn/v1", model: "FunAudioLLM/SenseVoiceSmall" });
    // Without a key the endpoint is not ready, and the card says what is missing.
    await app.waitFor("text:还差密钥");
    await app.type("id:speech-key", "sk-test-key");
    await app.submit("id:speech-key");
    await until((api) => api.speech?.key_set === true, "key saved");
    await app.waitFor("text:已就绪：输入框旁有麦克风").catch(() => undefined);
    expect(app.value("id:speech-key")).toBe("");
    expect(app.texts().some((text) => text.includes("sk-test-key"))).toBe(false);
    await app.press("id:speech-key-clear");
    await until((api) => api.speech?.key_set === false, "key cleared");
  } finally {
    await restore();
  }
});

test("the speech switch, a typed address and a typed model are saved", async () => {
  const { app, read, until, restore } = await session();
  try {
    await app.press("id:story-show-models");
    await app.press("id:models-tab-speech");
    await app.waitFor("id:speech-service");
    // The switch is there once a service is picked.
    await app.press("id:speech-service");
    await app.press("text:Groq");
    await app.waitFor("id:speech-enabled");
    const on = (await read()).speech?.enabled === true;
    await app.press("id:speech-enabled");
    await until((api) => (api.speech?.enabled === true) === !on, "switch flipped");
    await app.clear("id:speech-base-url");
    await app.type("id:speech-base-url", "http://127.0.0.1:9000/v1");
    // Typing saves after a short quiet (or when you leave the field).
    await until((api) => api.speech?.base_url === "http://127.0.0.1:9000/v1", "typed address saved");
    await app.clear("id:speech-model");
    await app.type("id:speech-model", "whisper-local");
    await until((api) => api.speech?.model === "whisper-local", "typed model saved");
    await app.waitFor("id:speech-status");
  } finally {
    await restore();
  }
});

test("a custom service shows the format picker; the others do not", async () => {
  const { app, until, restore } = await session();
  try {
    await app.press("id:story-show-models");
    await app.press("id:models-tab-speech");
    await app.waitFor("id:speech-service");
    await app.press("id:speech-service");
    await app.press("text:Groq");
    await until((api) => api.speech?.preset === "groq", "groq saved");
    expect(app.shows("id:speech-format")).toBe(false);
    await app.press("id:speech-service");
    await app.press("text:自定义");
    await until((api) => api.speech?.preset === "custom", "custom saved");
    await app.waitFor("id:speech-format");
  } finally {
    await restore();
  }
});

test("on a phone the sections are a list with what each is set to; one opens as a page and Back returns to the list", async () => {
  const { app } = await session({}, 500);
  await app.press("id:story-show-models");
  await app.waitFor("id:section-endpoints");
  expect(app.shows("id:models-tab-endpoints")).toBe(false);
  expect(app.shows("id:section-speech")).toBe(true);
  expect(app.shows("id:models-endpoints")).toBe(false);
  await app.press("id:section-speech");
  await app.waitFor("id:speech-settings");
  await app.waitFor("text:title:语音识别");
  await app.press("id:models-back");
  await app.waitFor("text:log:back:true");
  await app.waitFor("id:section-speech");
  expect(app.shows("id:speech-settings")).toBe(false);
  // On the list there is no page to go back from.
  await app.press("id:models-back");
  await app.waitFor("text:log:back:false");
});

test("the built-in call's model card follows the default until a model is picked, then saves it", async () => {
  const { app, until, restore } = await session();
  try {
    await app.press("id:story-show-model-card");
    await app.waitFor("id:side-model-reader");
    expect(app.texts().some((text) => text.includes("跟随默认"))).toBe(true);
    await app.press("id:side-model-picker");
    await app.waitFor("id:model-picker-panel");
    await app.press("text:fixture");
    const got = await until((api) => (api.builtin?.reader ?? null) !== null, "model saved");
    expect(got.builtin?.reader).toMatchObject({ model: "fixture" });
    await app.waitFor("id:model-picker-panel", { state: "gone" });
    // Back to following the default.
    await app.press("id:side-model-picker");
    await app.waitFor("id:model-picker-panel");
    await app.press("text:跟随默认（fixture）");
    await until((api) => api.builtin?.reader === null, "follows the default again");
  } finally {
    await restore();
  }
});
