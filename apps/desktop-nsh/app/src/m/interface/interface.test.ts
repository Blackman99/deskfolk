import "../../platform/install";
import { afterEach, describe, expect, test } from "nsh/test";
import { COPY, copyFor, copyLeaves, copyOverrideProblem, withCopyOverrides } from "../copy.ts";
import { formatFullTimestamp, formatMessageTime } from "../chat/chat-view.ts";
import { followingAccent, surfaceOf } from "./apply.ts";
import { interfaceBehaviour, setInterfaceBehaviour } from "./behaviour.svelte.ts";

afterEach(() => {
  setInterfaceBehaviour({});
});

describe("the profile's tokens (ADR 0106)", () => {
  test("your bubble follows a changed accent, unless you set it too", () => {
    expect(followingAccent({ "--bg": "#fff" }, "light")).toEqual({ "--bg": "#fff" });
    expect(followingAccent({ "--accent": "#0b7fc4" }, "light")).toEqual({ "--accent": "#0b7fc4", "--you": "var(--accent)", "--you-text": "var(--on-accent)" });
    expect(followingAccent({ "--accent": "#4db8ff", "--you": "#123456" }, "dark")).toEqual({ "--accent": "#4db8ff", "--you": "#123456" });
  });

  test("the surface a stylesheet is told it is on", () => {
    expect(surfaceOf(true)).toBe("phone");
    expect(surfaceOf(false, true)).toBe("tablet");
    expect(surfaceOf(false, false)).toBe("desktop");
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
    expect(copyOverrideProblem(base, "ui.history.more", "还有 处")).toBe("keeps {n}");
    const changed = withCopyOverrides(base, { "chat.sendHintShortcut": "发出（Enter）", "ui.history.more": "还有 {n} 处", "chat.nope": "x" });
    expect(changed.chat.sendHintShortcut).toBe("发出（Enter）");
    expect(changed.ui.history.more).toBe("还有 {n} 处");
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
