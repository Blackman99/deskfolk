/**
 * Every logo's data URI is an SVG WebKit will draw: on the phone page in Safari, a tag that repeats
 * an attribute (the spark's own `xmlns` beside the one `glyphUri` adds) draws nothing.
 */
import { expect, test } from "nsh/test";
import { glyphUri } from "./AgentLogo";
import { GLYPHS } from "./logo-glyphs";

const svgOf = (key: string) => decodeURIComponent(glyphUri(key, "#D97757", 16).slice("data:image/svg+xml,".length));

test("no tag in a logo's URI repeats an attribute", () => {
  for (const key of Object.keys(GLYPHS)) {
    for (const tag of svgOf(key).match(/<[^/!?][^>]*>/g) ?? []) {
      const names = [...tag.matchAll(/\s([\w:-]+)=/g)].map((m) => m[1]);
      expect(`${key}: ${names.filter((n, i) => names.indexOf(n) !== i).join(",")}`).toBe(`${key}: `);
    }
  }
});

test("each logo's root names the SVG namespace once, with the asked size", () => {
  for (const key of Object.keys(GLYPHS)) {
    const root = svgOf(key).match(/<svg\b[^>]*>/)?.[0] ?? "";
    expect(`${key}: ${root.split('xmlns="http://www.w3.org/2000/svg"').length - 1}`).toBe(`${key}: 1`);
    expect(root.includes('width="16"') && root.includes('height="16"')).toBe(true);
  }
});
