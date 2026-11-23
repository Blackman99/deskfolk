import { describe, expect, test } from "bun:test";
import { copyFor } from "./copy.ts";
import { shouldSearchOnShiftK } from "./search/shortcuts.ts";

describe("UI polish pure helpers and copy", () => {
  test("Ctrl+Shift+K yields to terminal clear on Windows and Linux only", () => {
    expect(shouldSearchOnShiftK("windows", true)).toBe(false);
    expect(shouldSearchOnShiftK("linux", true)).toBe(false);
    expect(shouldSearchOnShiftK("windows", false)).toBe(true);
    expect(shouldSearchOnShiftK("linux", false)).toBe(true);
    expect(shouldSearchOnShiftK("macos", true)).toBe(true);
    expect(shouldSearchOnShiftK("macos", false)).toBe(true);
  });

  test("trace-steps maps call_failed and interrupted in both locales", () => {
    const zh = copyFor("zh").traceSteps;
    const en = copyFor("en").traceSteps;
    expect(zh.failed("call_failed")).toBe("没成：调用失败");
    expect(zh.failed("interrupted")).toBe("没成：被打断");
    expect(en.failed("call_failed")).toBe("Did not work: the call failed");
    expect(en.failed("interrupted")).toBe("Did not work: interrupted");
  });

  test("newly added English copy keys contain no Chinese characters", () => {
    const en = copyFor("en");
    const samples: string[] = [
      en.common.system,
      en.common.noOptions,
      en.sidebar.skillNamePlaceholder,
      en.sidebar.skillDescriptionHint,
      en.sidebar.skillDescriptionPlaceholder,
      en.sidebar.skillBodyHint,
      en.sidebar.skillBodyPlaceholder,
      en.sidebar.skillOptional,
      en.sidebar.skillUsesPlaceholder,
      en.sidebar.skillEnabledOnDesc,
      en.sidebar.skillEnabledOffDesc,
      en.sidebar.memoryDisabledBadge,
      en.sidebar.memorySubjectPlaceholder,
      en.sidebar.memoryBodyHint,
      en.sidebar.memoryBodyPlaceholder,
      en.sidebar.memoryOriginTitle,
      en.sidebar.memoryEnabledOnDesc,
      en.sidebar.memoryEnabledOffDesc,
      en.routines.namePlaceholder,
      en.routines.instructionHint,
      en.routines.instructionPlaceholder,
      en.routines.enabledOnDesc,
      en.routines.enabledOffDesc,
      en.settings.mcpDeleteTitle,
      en.settings.mcpDeleteBody,
      en.settings.mcpConfirmDelete,
    ];
    for (const s of samples) {
      expect(typeof s).toBe("string");
      expect(s.length).toBeGreaterThan(0);
      expect(/[\u4e00-\u9fff]/.test(s)).toBe(false);
    }
  });
});
