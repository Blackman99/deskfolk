import { afterEach, describe, expect, test } from "bun:test";
import { applyInterfacePatch, emptyInterfaceProfile } from "@real-bot/protocol";
import { COPY, copyFor, copyLeaves, copyOverrideProblem, withCopyOverrides } from "../copy.ts";
import { formatFullTimestamp, formatMessageTime } from "../chat/chat-view.ts";
import { applyContentGlass, applyInterfaceCss, applyMotion, followingAccent, cachedInterfaceCss, cacheInterfaceCss, defaultAskedInUrl, interfaceCss, INTERFACE_STYLE_ID, surfaceOf } from "./apply.ts";
import { interfaceBehaviour, setInterfaceBehaviour } from "./behaviour.svelte.ts";
import { colorAlpha, floorProblem, floorsHiddenByProfile } from "./floor.ts";
import { badTokens, topLevelBlocks, unmatchedSelectors } from "./report.ts";

afterEach(() => {
  document.getElementById(INTERFACE_STYLE_ID)?.remove();
  document.body.innerHTML = "";
  delete document.documentElement.dataset.motion;
  setInterfaceBehaviour({});
  cacheInterfaceCss("");
});

describe("the profile as CSS (ADR 0106)", () => {
  test("light tokens on :root, dark ones where the dark defaults are, then the stylesheet", () => {
    const profile = applyInterfacePatch(emptyInterfaceProfile(), {
      tokens: { light: { "--accent": "#7c3aed" }, dark: { "--accent": "#a78bfa" } },
      css: { set: "[data-ui=\"sidebar\"] { opacity: 0.95; }" },
    });
    expect(interfaceCss(profile)).toBe(":root {\n  --accent: #7c3aed;\n  --you: var(--accent);\n  --you-text: var(--on-accent);\n}\n\n:root[data-theme=\"dark\"],\n[data-theme=\"dark\"] {\n  --accent: #a78bfa;\n  --you: color-mix(in oklab, var(--accent) 70%, black);\n}\n\n[data-ui=\"sidebar\"] { opacity: 0.95; }");
    expect(interfaceCss({ ...profile, enabled: false })).toBe("");
    expect(interfaceCss(emptyInterfaceProfile())).toBe("");
  });

  test("your bubble follows a changed accent, unless you set it too", () => {
    expect(followingAccent({ "--bg": "#fff" }, "light")).toEqual({ "--bg": "#fff" });
    expect(followingAccent({ "--accent": "#0b7fc4" }, "light")).toEqual({ "--accent": "#0b7fc4", "--you": "var(--accent)", "--you-text": "var(--on-accent)" });
    expect(followingAccent({ "--accent": "#4db8ff", "--you": "#123456" }, "dark")).toEqual({ "--accent": "#4db8ff", "--you": "#123456" });
  });

  test("goes in last as text, can be switched off, and leaves when empty", () => {
    const style = applyInterfaceCss("a { color: red; }", true)!;
    expect(document.head.lastElementChild).toBe(style);
    expect(style.textContent).toBe("a { color: red; }");
    expect(style.media).toBe("all");
    applyInterfaceCss("a { color: red; }", false);
    expect(style.media).toBe("not all");
    applyInterfaceCss("", true);
    expect(document.getElementById(INTERFACE_STYLE_ID)).toBeNull();
  });

  test("the last text is kept for the next start; ?ui=default asks for the app's own look", () => {
    cacheInterfaceCss(":root { --bg: white; }");
    expect(cachedInterfaceCss()).toBe(":root { --bg: white; }");
    expect(defaultAskedInUrl({ search: "?s=1&ui=default" })).toBe(true);
    expect(defaultAskedInUrl({ search: "?s=1" })).toBe(false);
  });

  test("surface and motion are on the root for stylesheets and base.css", () => {
    expect(surfaceOf(true)).toBe("phone");
    expect(surfaceOf(false, true)).toBe("tablet");
    expect(surfaceOf(false, false)).toBe("desktop");
    applyMotion("reduce");
    expect(document.documentElement.dataset.motion).toBe("reduce");
    applyMotion("system");
    expect(document.documentElement.dataset.motion).toBeUndefined();
    applyContentGlass("frosted");
    expect(document.documentElement.dataset.contentGlass).toBe("frosted");
    applyContentGlass("solid");
    expect(document.documentElement.dataset.contentGlass).toBeUndefined();
  });
});

describe("the floor", () => {
  const fakeWindow = () => ({
    document: { elementFromPoint: undefined },
    getComputedStyle: (el: Element) => window.getComputedStyle(el),
    innerWidth: 1000,
    innerHeight: 800,
  }) as unknown as Window;

  test("reads a colour's alpha", () => {
    expect(colorAlpha("rgb(1, 2, 3)")).toBe(1);
    expect(colorAlpha("rgba(1, 2, 3, 0.2)")).toBe(0.2);
    expect(colorAlpha("transparent")).toBe(0);
    expect(colorAlpha("color(srgb 1 0 0 / 0.5)")).toBe(0.5);
  });

  test("a button hidden, see-through, tiny or click-through is not usable", () => {
    document.body.innerHTML = "<button data-floor=\"stop\">Stop</button>";
    const button = document.querySelector("button")!;
    const rect = { width: 40, height: 28, top: 10, left: 10, bottom: 38, right: 50, x: 10, y: 10, toJSON() {} };
    button.getBoundingClientRect = () => rect as DOMRect;
    // happy-dom does no hit testing: a window without elementFromPoint leaves that part out.
    const noHit = fakeWindow();
    expect(floorProblem(button, noHit)).toBeNull();
    button.style.display = "none";
    expect(floorProblem(button, noHit)).toBe("display: none");
    button.style.display = "";
    button.style.opacity = "0.3";
    expect(floorProblem(button, noHit)).toBe("opacity 0.30");
    button.style.opacity = "";
    button.style.pointerEvents = "none";
    expect(floorProblem(button, noHit)).toBe("pointer-events: none");
    button.style.pointerEvents = "";
    rect.width = 4;
    expect(floorProblem(button, noHit)).toBe("size 4×28");
  });

  test("only a failure the profile causes counts: checked again with its sheet off", () => {
    document.body.innerHTML = "<button data-floor=\"approval\">Allow</button><button data-floor=\"stop\" style=\"display:none\">Stop</button>";
    const [allow] = Array.from(document.querySelectorAll("button"));
    for (const el of document.querySelectorAll("button")) {
      el.getBoundingClientRect = () => ({ width: 40, height: 28, top: 10, left: 10, bottom: 38, right: 50 }) as DOMRect;
    }
    let on = true;
    allow!.style.visibility = "hidden";
    const hidden = floorsHiddenByProfile((next) => {
      on = next;
      allow!.style.visibility = next ? "hidden" : "";
    }, document, fakeWindow());
    // The Allow button was the profile's doing; Stop is hidden by the app itself and does not count.
    expect(hidden).toEqual([{ floor: "approval", why: "visibility: hidden" }]);
    expect(on).toBe(true);
  });
});

describe("what a window reports", () => {
  test("splits a stylesheet into its top-level blocks, comments and strings kept whole", () => {
    expect(topLevelBlocks("/* a { } */ a { color: red; } @media (x) { b { c: d } } @layer x;\ne { content: \"}\"; }"))
      .toEqual(["/* a { } */ a { color: red; }", "@media (x) { b { c: d } }", "@layer x;", "e { content: \"}\"; }"]);
  });

  test("names the selectors that match nothing here, leaving states and parts aside", () => {
    document.body.innerHTML = "<div data-ui=\"sidebar\"><button>x</button></div>";
    const rules = [
      { selectorText: "[data-ui=\"sidebar\"]" },
      { selectorText: "[data-ui=\"sidebar\"] button:hover, .gone" },
      { selectorText: "[data-ui=\"sidebar\"]::before" },
      { selectorText: ":root" },
    ];
    const sheet = { cssRules: rules } as unknown as CSSStyleSheet;
    expect(unmatchedSelectors(sheet, document)).toEqual([".gone"]);
  });

  test("names token values a colour token would not take", () => {
    const profile = applyInterfacePatch(emptyInterfaceProfile(), { tokens: { light: { "--accent": "banana", "--radius-md": "8px", "--bg": "var(--ink)" } } });
    const css = { supports: (property: string, value: string) => property !== "color" || /^#|^rgb|^teal$/.test(value) };
    expect(badTokens(profile, new Map([["--accent", "teal"], ["--radius-md", "6px"], ["--bg", "#fff"]]), css)).toEqual(["--accent"]);
  });
});

describe("the app's words, changed", () => {
  test("a change takes where the app has plain words, and keeps their placeholders", () => {
    const base = COPY.zh;
    const leaves = copyLeaves(base);
    expect(leaves["chat.sendHintShortcut"]).toBe("发送（Enter）");
    expect(copyOverrideProblem(base, "chat.sendHintShortcut", "发出")).toBeNull();
    expect(copyOverrideProblem(base, "chat.nope", "x")).toBe("no words at that key");
    expect(copyOverrideProblem(base, "chat", "x")).toBe("not plain words at that key");
    expect(copyOverrideProblem(base, "ui.css.length", "共 字")).toBe("keeps {n}");
    const changed = withCopyOverrides(base, { "chat.sendHintShortcut": "发出（Enter）", "ui.css.length": "共 {n} 字", "chat.nope": "x" });
    expect(changed.chat.sendHintShortcut).toBe("发出（Enter）");
    expect(changed.ui.css.length).toBe("共 {n} 字");
    // Only the objects on the way are copied; the rest are the app's own.
    expect(changed.composer).toBe(base.composer);
    expect(base.chat.sendHintShortcut).toBe("发送（Enter）");
  });

  test("copyFor lays them over the language asked for, once per change set", () => {
    const words = { "chat.sendHintShortcut": "Send it" };
    expect(copyFor("en", words).chat.sendHintShortcut).toBe("Send it");
    expect(copyFor("en", words)).toBe(copyFor("en", words));
    expect(copyFor("en", null)).toBe(COPY.en);
  });
});

describe("behaviour where it applies", () => {
  test("a message's time follows the time format", () => {
    const at = new Date(2026, 10, 4, 14, 5, 9).toISOString();
    expect(formatMessageTime(at)).toBe("14:05");
    setInterfaceBehaviour({ time_format: "12h" });
    expect(interfaceBehaviour().time_format).toBe("12h");
    expect(formatMessageTime(at)).toBe("2:05 PM");
    expect(formatFullTimestamp(at)).toBe("2026-11-04 2:05:09 PM");
    expect(formatMessageTime(new Date(2026, 0, 1, 0, 30).toISOString())).toBe("12:30 AM");
  });
});

describe("which key sends", () => {
  async function press(init: KeyboardEventInit): Promise<{ sent: number; newlines: number }> {
    const { handleComposerKey } = await import("../chat/composer-keys.ts");
    const { COMPOSER_IME_IDLE } = await import("../chat/composer-ime.ts");
    const editor = document.createElement("div");
    editor.contentEditable = "true";
    document.body.appendChild(editor);
    let sent = 0;
    const before = editor.innerHTML;
    handleComposerKey(new KeyboardEvent("keydown", { key: "Enter", ...init }), {
      composerIme: () => COMPOSER_IME_IDLE,
      setComposerIme: () => {},
      lockedComposer: () => false,
      selected: () => ({ id: "s" }) as never,
      mentions: { showMentionPopup: false } as never,
      onEditLast: () => undefined,
      hasContent: () => true,
      view: () => null,
      editorEl: () => editor,
      syncDraftFromEditor: () => {},
      checkMentionTrigger: () => {},
      send: async () => {
        sent += 1;
      },
    });
    return { sent, newlines: editor.innerHTML !== before ? 1 : 0 };
  }

  test("Enter sends by default; with ⌘/Ctrl+Enter chosen, Enter is a new line", async () => {
    expect((await press({})).sent).toBe(1);
    expect((await press({ shiftKey: true })).sent).toBe(0);
    setInterfaceBehaviour({ send_key: "mod_enter" });
    const plain = await press({});
    expect(plain.sent).toBe(0);
    expect((await press({ metaKey: true })).sent).toBe(1);
    expect((await press({ ctrlKey: true })).sent).toBe(1);
  });
});
