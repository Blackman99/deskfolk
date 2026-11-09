/** Code colours: the messenger's themes by place, your interface's choice over them, runs as decorations. */
import { expect, test } from "nsh/test";
import { setInterfaceBehaviour } from "../m/interface/behaviour.svelte.ts";
import { codeThemes, colorDecorations, highlightCode } from "./code-colors";

test("chat takes GitHub's colours and the editor Vitesse's, until your interface chooses a theme", () => {
  setInterfaceBehaviour({});
  expect(codeThemes("chat")).toEqual({ light: "github-light", dark: "github-dark" });
  expect(codeThemes("editor")).toEqual({ light: "vitesse-light", dark: "vitesse-dark" });
  setInterfaceBehaviour({ code_theme: { dark: "dracula" } });
  expect(codeThemes("chat")).toEqual({ light: "github-light", dark: "dracula" });
  expect(codeThemes("editor")).toEqual({ light: "vitesse-light", dark: "dracula" });
  setInterfaceBehaviour({});
});

test("a keyword is a decoration in its theme's colour, and runs of one colour share a style", () => {
  const runs = highlightCode("const a = 1;\nconst b = 2;", "ts", "github-light", false);
  expect(runs).not.toBeNull();
  const decorations = colorDecorations(runs!);
  const first = decorations[0]!;
  expect(first.range).toEqual({ start: { line: 0, column: 0 }, end: { line: 0, column: 5 } });
  expect((first.style as { color: string }).color.toLowerCase()).toBe("#d73a49");
  const second = decorations.find((d) => d.range.start.line === 1 && d.range.start.column === 0)!;
  expect(second.style).toBe(first.style);
});

test("an unknown language, or code past the limit, is left to NSH's colours", () => {
  expect(highlightCode("x", "notes.unknownext", "github-light", false)).toBeNull();
  expect(highlightCode("x".repeat(200_001), "ts", "github-light", false)).toBeNull();
});
