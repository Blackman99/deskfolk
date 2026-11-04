import { describe, expect, test } from "bun:test";
import {
  applyInterfacePatch,
  cssProblem,
  emptyInterfaceProfile,
  interfaceChanges,
  InterfacePatchError,
  normalizeInterfaceProfile,
  tokenValueProblem,
  UI_FLOORS,
  UI_HOOKS,
} from "./interface.ts";

function patchError(run: () => unknown): InterfacePatchError {
  try {
    run();
  } catch (error) {
    if (error instanceof InterfacePatchError) return error;
    throw error;
  }
  throw new Error("expected the patch to be refused");
}

describe("interface profile (ADR 0106)", () => {
  test("tokens go to the look they name, both to each, and null takes one back", () => {
    let profile = applyInterfacePatch(emptyInterfaceProfile(), { tokens: { both: { "--accent": "#7c3aed" }, dark: { "--bg": "#101014" } } });
    expect(profile.tokens).toEqual({ light: { "--accent": "#7c3aed" }, dark: { "--accent": "#7c3aed", "--bg": "#101014" } });
    profile = applyInterfacePatch(profile, { tokens: { dark: { "--accent": null } } });
    expect(profile.tokens.dark).toEqual({ "--bg": "#101014" });
    expect(profile.tokens.light).toEqual({ "--accent": "#7c3aed" });
  });

  test("a token is a --name with a plain value", () => {
    expect(patchError(() => applyInterfacePatch(emptyInterfaceProfile(), { tokens: { light: { accent: "red" } } })).message).toContain("not a token name");
    for (const bad of ["red; color: blue", "url(https://x.test/a.png)", "red !important", "", "a}b"]) {
      expect(tokenValueProblem(bad)).not.toBeNull();
    }
    expect(tokenValueProblem("color-mix(in oklab, var(--accent) 40%, white)")).toBeNull();
  });

  test("the stylesheet changes like a prompt: replace once, add after once, append, or set whole", () => {
    let profile = applyInterfacePatch(emptyInterfaceProfile(), { css: { set: "[data-ui=\"sidebar\"] { opacity: 0.9; }" } });
    profile = applyInterfacePatch(profile, { css: { edits: [{ old: "0.9", new: "0.95" }, { add: "[data-ui=\"tab\"] { font-weight: 600; }" }] } });
    expect(profile.css).toBe("[data-ui=\"sidebar\"] { opacity: 0.95; }\n[data-ui=\"tab\"] { font-weight: 600; }");
    profile = applyInterfacePatch(profile, { css: { edits: [{ after: "opacity: 0.95;", add: " color: var(--ink);" }] } });
    expect(profile.css).toContain("opacity: 0.95; color: var(--ink);");
    expect(patchError(() => applyInterfacePatch(profile, { css: { edits: [{ old: "nowhere", new: "x" }] } })).code).toBe("not_found");
    expect(patchError(() => applyInterfacePatch(profile, { css: { edits: [{ old: "data-ui", new: "x" }] } })).code).toBe("ambiguous");
  });

  test("a stylesheet loads nothing from elsewhere and holds no markup", () => {
    expect(cssProblem("@import url(x.css);")).not.toBeNull();
    expect(cssProblem("a { background: url(https://evil.test/?q=1) }")).not.toBeNull();
    expect(cssProblem("a { background: url('/local.png') }")).not.toBeNull();
    expect(cssProblem("</style><script>alert(1)</script>")).not.toBeNull();
    expect(cssProblem("a { background: url(\"data:image/svg+xml;utf8,<svg/>\") }")).toBeNull();
    expect(cssProblem("[data-ui=\"chat\"] { --accent: teal; }")).toBeNull();
  });

  test("behaviour takes only what is on its list", () => {
    let profile = applyInterfacePatch(emptyInterfaceProfile(), { behaviour: { send_key: "mod_enter", open_placement: { preview: "float" } } });
    expect(profile.behaviour).toEqual({ send_key: "mod_enter", open_placement: { preview: "float" } });
    profile = applyInterfacePatch(profile, { behaviour: { open_placement: { terminal: "tab" } } });
    expect(profile.behaviour.open_placement).toEqual({ preview: "float", terminal: "tab" });
    profile = applyInterfacePatch(profile, { behaviour: { open_placement: { preview: null, terminal: null }, send_key: null } });
    expect(profile.behaviour).toEqual({});
    expect(patchError(() => applyInterfacePatch(profile, { behaviour: { send_key: "space" } })).message).toContain("enter, mod_enter");
    expect(patchError(() => applyInterfacePatch(profile, { behaviour: { density: "compact" } })).message).toContain("not on the list");
  });

  test("a reset puts parts back before the rest applies", () => {
    const start = applyInterfacePatch(emptyInterfaceProfile(), { tokens: { light: { "--accent": "red" } }, css: { set: "a{}" } });
    const next = applyInterfacePatch(start, { reset: ["tokens", "css"], tokens: { light: { "--bg": "white" } } });
    expect(next.tokens.light).toEqual({ "--bg": "white" });
    expect(next.css).toBe("");
  });

  test("words are keyed by where they sit and never blank", () => {
    const profile = applyInterfacePatch(emptyInterfaceProfile(), { copy: { zh: { "composer.send": "发出" } } });
    expect(profile.copy.zh).toEqual({ "composer.send": "发出" });
    expect(patchError(() => applyInterfacePatch(profile, { copy: { zh: { "composer.send": " " } } })).code).toBe("invalid_args");
    expect(patchError(() => applyInterfacePatch(profile, { copy: { fr: {} } })).code).toBe("invalid_args");
  });

  test("a stored profile is read leniently", () => {
    const read = normalizeInterfaceProfile({ enabled: false, tokens: { light: { "--accent": "red", nope: "x" } }, behaviour: { motion: "reduce", send_key: "space" }, css: "@import x;" });
    expect(read).toEqual({ enabled: false, tokens: { light: { "--accent": "red" }, dark: {} }, behaviour: { motion: "reduce" }, css: "", copy: { zh: {}, en: {} } });
  });

  test("what changed reads in a few words", () => {
    const before = { profile: emptyInterfaceProfile(), theme: "system" as const, locale: "zh" as const };
    const after = { profile: applyInterfacePatch(before.profile, { tokens: { light: { "--accent": "red" } }, behaviour: { time_format: "12h" } }), theme: "dark" as const, locale: "zh" as const };
    expect(interfaceChanges(before, after)).toEqual(["theme: dark", "light --accent: red", "time_format: \"12h\""]);
  });

  test("hooks and floors have unique names", () => {
    const names = UI_HOOKS.map(([name]) => name);
    expect(new Set(names).size).toBe(names.length);
    expect(new Set(UI_FLOORS).size).toBe(UI_FLOORS.length);
  });
});
