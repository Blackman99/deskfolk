import { expect, test } from "bun:test";
import { documentTheme, findDecorations, minimumContrast, terminalColors, terminalTheme } from "./terminal-theme.ts";

const COLOURS = [
  "black", "red", "green", "yellow", "blue", "magenta", "cyan", "white",
  "brightBlack", "brightRed", "brightGreen", "brightYellow", "brightBlue", "brightMagenta", "brightCyan", "brightWhite",
] as const;

test("each theme gives all sixteen ANSI colours, and the two differ", () => {
  const light = terminalTheme("light");
  const dark = terminalTheme("dark");
  for (const name of COLOURS) {
    expect(light[name]).toMatch(/^#[0-9a-f]{6}$/);
    expect(dark[name]).toMatch(/^#[0-9a-f]{6}$/);
  }
  expect(light.blue).not.toBe(dark.blue);
});

test("background and text are the pane's own tokens, and the cursor is drawn in the text colour", () => {
  const tokens: Record<string, string> = { "--pane": " #161e2b", "--ink": "#f1f5f9 " };
  const theme = terminalTheme("dark", (name) => tokens[name] ?? "");
  expect(theme.background).toBe("#161e2b");
  expect(theme.foreground).toBe("#f1f5f9");
  expect(theme.cursor).toBe("#f1f5f9");
  expect(theme.cursorAccent).toBe("#161e2b");
  // Without a stylesheet the light pane is still white, not the old always-dark fallback.
  expect(terminalTheme("light").background).toBe("#ffffff");
});

test("only the white pane asks xterm to lift faint colours", () => {
  expect(minimumContrast("light")).toBe(4.5);
  expect(minimumContrast("dark")).toBe(1);
});

test("find's highlights are #RRGGBB, the only form xterm takes for them", () => {
  for (const theme of ["light", "dark"] as const) {
    const options = findDecorations(theme);
    for (const value of Object.values(options)) {
      if (typeof value === "string") expect(value).toMatch(/^#[0-9a-f]{6}$/);
    }
  }
});

test("the window's data-theme decides light or dark", () => {
  const root = document.createElement("div");
  root.setAttribute("data-theme", "dark");
  expect(documentTheme(root)).toBe("dark");
  root.setAttribute("data-theme", "light");
  expect(documentTheme(root)).toBe("light");
});

test("the colours the daemon answers with are the pane's, as #rrggbb", () => {
  const theme = terminalTheme("light", (name) => ({ "--pane": "#fff", "--ink": "rgb(15, 23, 42)" })[name] ?? "");
  const colors = terminalColors("light", theme);
  expect(colors.background).toBe("#ffffff");
  expect(colors.foreground).toBe("#0f172a");
  expect(colors.cursor).toBe("#0f172a");
  expect(colors.palette).toHaveLength(16);
  expect(colors.palette![1]).toBe(theme.red!);
  // A token that is no colour at all is not sent as one.
  expect(terminalColors("dark", { ...terminalTheme("dark"), background: "var(--x)" }).background).toBe("#161e2b");
});
