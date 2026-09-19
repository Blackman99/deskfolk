import { expect, test } from "bun:test";
import {
  applyMonacoLanguageConfiguration,
  ensureMonacoLanguageRegistered,
  languageConfKind,
  languageConfigurationFor,
  languageConfigurationFromModule,
} from "./monaco-language-config.ts";

test("languageConfKind maps shipped langs to monaco conf or a static fallback", () => {
  expect(languageConfKind("typescript")).toBe("static");
  expect(languageConfKind("html")).toBe("static");
  expect(languageConfKind("shellscript")).toBe("static");
  expect(languageConfKind("json")).toBe("static");
  expect(languageConfKind("toml")).toBe("static");
  expect(languageConfKind("haskell")).toBe("static");
  expect(languageConfKind("plaintext")).toBe("none");
});

test("languageConfigurationFromModule reads conf and ignores tokenizers", () => {
  expect(
    languageConfigurationFromModule({
      conf: { comments: { lineComment: "#" } },
      language: { tokenizer: {} },
    }),
  ).toEqual({ comments: { lineComment: "#" } });
  expect(languageConfigurationFromModule({})).toBeNull();
  expect(languageConfigurationFromModule(null)).toBeNull();
});

test("languageConfigurationFor supplies brackets without a monaco language module", () => {
  expect(languageConfigurationFor("python")?.folding?.offSide).toBe(true);
  expect(languageConfigurationFor("html")?.comments).toEqual({ blockComment: ["<!--", "-->"] });
  expect(languageConfigurationFor("typescript")?.brackets).toEqual([
    ["{", "}"],
    ["[", "]"],
    ["(", ")"],
  ]);
  expect(languageConfigurationFor("plaintext")).toBeNull();
});

test("applyMonacoLanguageConfiguration registers unknown langs before setting conf", async () => {
  const ids: string[] = ["plaintext"];
  const confs: Array<{ id: string; conf: { comments?: { lineComment?: string } } }> = [];
  const monaco = {
    getLanguages: () => ids.map((id) => ({ id })),
    register: ({ id }: { id: string }) => {
      ids.push(id);
    },
    setLanguageConfiguration: (id: string, conf: { comments?: { lineComment?: string } }) => {
      confs.push({ id, conf });
    },
  };
  expect(ensureMonacoLanguageRegistered(monaco, "python")).toBe(true);
  expect(ids).toContain("python");
  await applyMonacoLanguageConfiguration(monaco, "python");
  expect(confs[0]?.id).toBe("python");
  expect(confs[0]?.conf.comments?.lineComment).toBe("#");
});
