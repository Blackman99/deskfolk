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

  test("a stylesheet can no longer be written, only one saved before cleared (ADR 0117)", () => {
    const saved = { ...emptyInterfaceProfile(), css: "[data-ui=\"sidebar\"] { opacity: 0.9; }" };
    expect(patchError(() => applyInterfacePatch(emptyInterfaceProfile(), { css: { set: "a{}" } })).code).toBe("unsupported");
    expect(patchError(() => applyInterfacePatch(saved, { css: { edits: [{ add: "b{}" }] } })).code).toBe("unsupported");
    expect(patchError(() => applyInterfacePatch(saved, { css: { set: "", edits: [] } })).code).toBe("unsupported");
    expect(applyInterfacePatch(saved, { css: { set: "" } }).css).toBe("");
    expect(applyInterfacePatch(saved, { reset: ["css"] }).css).toBe("");
    // What is saved reads back as it was, so old revisions and restores are untouched.
    expect(normalizeInterfaceProfile(saved).css).toBe(saved.css);
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

  test("code colours come from a fixed list per look, each look on its own", () => {
    let profile = applyInterfacePatch(emptyInterfaceProfile(), { behaviour: { code_theme: { dark: "dracula" } } });
    expect(profile.behaviour.code_theme).toEqual({ dark: "dracula" });
    profile = applyInterfacePatch(profile, { behaviour: { code_theme: { light: "solarized-light" } } });
    expect(profile.behaviour.code_theme).toEqual({ dark: "dracula", light: "solarized-light" });
    profile = applyInterfacePatch(profile, { behaviour: { code_theme: { dark: null } } });
    expect(profile.behaviour.code_theme).toEqual({ light: "solarized-light" });
    profile = applyInterfacePatch(profile, { behaviour: { code_theme: null } });
    expect(profile.behaviour.code_theme).toBeUndefined();
    // A dark theme for the light look, or one not on the list, is refused.
    expect(patchError(() => applyInterfacePatch(profile, { behaviour: { code_theme: { light: "dracula" } } })).message).toContain("github-light");
    expect(patchError(() => applyInterfacePatch(profile, { behaviour: { code_theme: { dark: "my-theme" } } })).code).toBe("invalid_args");
    expect(patchError(() => applyInterfacePatch(profile, { behaviour: { code_theme: { sepia: "nord" } } })).message).toContain("light or dark");
    expect(normalizeInterfaceProfile({ behaviour: { code_theme: { dark: "nord" } } }).behaviour).toEqual({ code_theme: { dark: "nord" } });
  });

  test("content glass is solid, frosted or clear", () => {
    const profile = applyInterfacePatch(emptyInterfaceProfile(), { behaviour: { content_glass: "frosted" } });
    expect(profile.behaviour.content_glass).toBe("frosted");
    expect(applyInterfacePatch(profile, { behaviour: { content_glass: null } }).behaviour.content_glass).toBeUndefined();
    expect(patchError(() => applyInterfacePatch(profile, { behaviour: { content_glass: "glassy" } })).message).toContain("solid, frosted, clear");
  });

  test("external_link_open is webview or browser, and web is an open placement kind", () => {
    let profile = applyInterfacePatch(emptyInterfaceProfile(), { behaviour: { external_link_open: "browser", open_placement: { web: "float" } } });
    expect(profile.behaviour.external_link_open).toBe("browser");
    expect(profile.behaviour.open_placement?.web).toBe("float");
    profile = applyInterfacePatch(profile, { behaviour: { external_link_open: null, open_placement: { web: null } } });
    expect(profile.behaviour).toEqual({});
    expect(patchError(() => applyInterfacePatch(profile, { behaviour: { external_link_open: "tab" } })).message).toContain("webview, browser");
  });

  test("a reset puts parts back before the rest applies", () => {
    const start = { ...applyInterfacePatch(emptyInterfaceProfile(), { tokens: { light: { "--accent": "red" } } }), css: "a{}" };
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
