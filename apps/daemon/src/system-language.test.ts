import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "./store";
import { firstListed, languageOf } from "./system-language";

describe("the system's language", () => {
  test("is the first entry of the list `defaults read -g AppleLanguages` prints", () => {
    expect(firstListed('(\n    "zh-Hans-CN"\n)\n')).toBe("zh-Hans-CN");
    expect(firstListed('(\n    "en-US",\n    "zh-Hans-CN"\n)')).toBe("en-US");
    expect(firstListed("(\n    en,\n    ja\n)")).toBe("en");
    expect(firstListed("(\n)")).toBeNull();
    expect(firstListed("")).toBeNull();
  });

  test("reads as 中文 for any Chinese, as English for any other language, and as nothing when empty", () => {
    expect(languageOf("zh-Hans-CN")).toBe("zh");
    expect(languageOf("zh_TW")).toBe("zh");
    expect(languageOf("en-GB")).toBe("en");
    expect(languageOf("ja-JP")).toBe("en");
    expect(languageOf(" ")).toBeNull();
    expect(languageOf(null)).toBeNull();
  });
});

describe("the language a database starts in", () => {
  test("a brand new database takes the system's; one that already has settings keeps its own", () => {
    const dir = mkdtempSync(join(tmpdir(), "real-bot-first-locale-"));
    const file = join(dir, "state.sqlite");
    try {
      const created = new Store({ filename: file, firstLocale: () => "en" });
      expect(created.settingsCached().locale).toBe("en");
      created.patchSettingsSync({ locale: "zh" });
      created.close();

      let asked = 0;
      const reopened = new Store({ filename: file, firstLocale: () => { asked += 1; return "en"; } });
      expect(reopened.settingsCached().locale).toBe("zh");
      expect(asked).toBe(0);
      reopened.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("without the system's language, or when it cannot be read, a new database starts in 中文", () => {
    expect(new Store().settingsCached().locale).toBe("zh");
    expect(new Store({ firstLocale: () => null }).settingsCached().locale).toBe("zh");
  });
});
