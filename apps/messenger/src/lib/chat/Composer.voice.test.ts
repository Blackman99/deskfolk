import { afterEach, expect, test } from "bun:test";
import type { SpeechSettings } from "@real-bot/protocol";
import { flushSync } from "svelte";
import { copyFor } from "../copy.ts";
import { settle } from "../test-async.ts";
import { aBot, aDirect, fakeRuntime } from "../test-fixtures.ts";
import { reactive } from "../test-reactive.svelte.ts";
import { click, render } from "../test-render.ts";
import { installFakeMic, type FakeMic } from "../test-voice.ts";
import Composer from "./Composer.svelte";

const t = copyFor("zh");

const ready: SpeechSettings = {
  enabled: true,
  preset: "openai",
  format: "openai",
  base_url: "https://api.openai.com/v1",
  model: "gpt-4o-mini-transcribe",
  language: null,
  key_provider_id: null,
  key_set: true,
};

let mic: FakeMic | null = null;
afterEach(() => {
  mic?.restore();
  mic = null;
});

function open(opts: { speech?: SpeechSettings | null; draft?: string; heard?: string } = {}) {
  const selected = aDirect();
  const runtime = reactive(fakeRuntime({ bots: [aBot({ id: "bot-1" })], sessions: [selected] }));
  runtime.snapshot = { ...runtime.snapshot, settings: { ...runtime.snapshot.settings, speech: opts.speech === undefined ? ready : opts.speech } };
  runtime.selectedId = selected.id;
  runtime.draft = opts.draft ?? "";
  const sent: unknown[] = [];
  let sends = 0;
  (runtime as unknown as { client: unknown }).client = {
    transcribe: async (body: unknown) => {
      sent.push(body);
      return { text: opts.heard ?? "你好" };
    },
  };
  const view = render(Composer, { runtime, t, selected, onSend: async () => { sends++; return true; }, onPickPrompt: () => {} });
  flushSync();
  const editor = view.host.querySelector(".composer-input") as HTMLElement;
  const button = () => view.host.querySelector<HTMLButtonElement>("[data-voice-button]");
  return { ...view, runtime, editor, sent, button, selected, sends: () => sends };
}

test("the microphone shows only once a speech endpoint is ready", () => {
  for (const speech of [null, { ...ready, enabled: false }, { ...ready, key_set: false }]) {
    const { button, close } = open({ speech });
    expect(button()).toBeNull();
    close();
  }
  const { button, close } = open();
  expect(button()?.getAttribute("aria-label")).toBe(t.speech.micStart);
  close();
});

test("record, stop, and what was heard is added to the draft; nothing is sent", async () => {
  mic = installFakeMic();
  const { button, host, runtime, sent, editor, sends, close } = open({ draft: "写点什么" });
  try {
    click(button());
    await settle();
    expect(button()?.getAttribute("aria-pressed")).toBe("true");
    expect(host.querySelector("[data-voice-status]")?.textContent).toContain("正在听 0:00");
    click(button());
    await settle();
    await settle();
    expect(sent).toEqual([{ audio: Buffer.from("voice bytes").toString("base64"), mime: "audio/webm;codecs=opus" }]);
    expect(runtime.draft).toBe("写点什么你好");
    expect(editor.textContent).toBe("写点什么你好");
    expect(host.querySelector("[data-voice-status]")).toBeNull();
    expect(mic.stopped).toBe(1);
    expect(sends()).toBe(0);
  } finally {
    close();
  }
});

test("what is heard goes in where the caret was", async () => {
  mic = installFakeMic();
  const { button, runtime, editor, close } = open({ draft: "前后", heard: "中间" });
  try {
    const text = editor.firstChild!;
    const range = document.createRange();
    range.setStart(text, 1);
    range.collapse(true);
    window.getSelection()!.removeAllRanges();
    window.getSelection()!.addRange(range);
    click(button());
    await settle();
    click(button());
    await settle();
    await settle();
    expect(runtime.draft).toBe("前中间后");
  } finally {
    close();
  }
});

test("a refused microphone says so above the box, and can be put away", async () => {
  mic = installFakeMic({ deny: "NotAllowedError" });
  const { button, host, close } = open();
  try {
    click(button());
    await settle();
    const notice = host.querySelector("[data-voice-notice]");
    expect(notice?.textContent).toContain(t.speech.micDenied);
    click(notice?.querySelector("button"));
    flushSync();
    expect(host.querySelector("[data-voice-notice]")).toBeNull();
  } finally {
    close();
  }
});
