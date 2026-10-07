import { describe, expect, test } from "bun:test";
import {
  generateBoringAvatar,
  generatedAvatarVariant,
  BORING_AVATAR_VARIANTS,
  hashCode,
  DEFAULT_BORING_PALETTES,
  FOLK_FILLS,
  folkLook,
} from "@real-bot/protocol";

describe("boring-avatars SVG generator", () => {
  test("generates deterministic SVG for the same name", () => {
    const svg1 = generateBoringAvatar({ name: "Researcher", variant: "beam" });
    const svg2 = generateBoringAvatar({ name: "Researcher", variant: "beam" });
    expect(svg1).toBe(svg2);
    expect(svg1.startsWith("<svg")).toBe(true);
    expect(svg1.endsWith("</svg>")).toBe(true);
    expect(svg1).toContain("viewBox=\"0 0 36 36\"");
  });

  test("different names produce different output", () => {
    const a = generateBoringAvatar({ name: "Writer" });
    const b = generateBoringAvatar({ name: "Reviewer" });
    expect(a).not.toBe(b);
  });

  test("every variant generates valid SVG", () => {
    for (const variant of BORING_AVATAR_VARIANTS) {
      const svg = generateBoringAvatar({ name: "Coordinator", variant });
      expect(svg.startsWith("<svg")).toBe(true);
      expect(svg.endsWith("</svg>")).toBe(true);
      expect(svg.length).toBeGreaterThan(100);
    }
  });

  test("empty or whitespace name defaults gracefully without crashing", () => {
    const svgEmpty = generateBoringAvatar({ name: "" });
    const svgWhitespace = generateBoringAvatar({ name: "   " });
    expect(svgEmpty.startsWith("<svg")).toBe(true);
    expect(svgWhitespace.startsWith("<svg")).toBe(true);
    expect(svgEmpty).toBe(svgWhitespace);
  });

  test("escapes XML special characters in title", () => {
    const svg = generateBoringAvatar({
      name: `Bot <"Special" & 'Hero'>`,
      title: true,
    });
    expect(svg).toContain("<title>Bot &lt;&quot;Special&quot; &amp; &apos;Hero&apos;&gt;</title>");
  });

  test("supports square and custom palettes", () => {
    const svgRound = generateBoringAvatar({ name: "Bot1", square: false });
    const svgSquare = generateBoringAvatar({ name: "Bot1", square: true });
    expect(svgRound).not.toBe(svgSquare);

    const svgCustomColors = generateBoringAvatar({
      name: "Bot1",
      variant: "beam",
      colors: DEFAULT_BORING_PALETTES.neon,
    });
    expect(svgCustomColors).toContain("#00F0FF");
  });

  test("hashCode handles various string lengths and unicode", () => {
    expect(typeof hashCode("bot")).toBe("number");
    expect(typeof hashCode("架构师")).toBe("number");
    expect(typeof hashCode("")).toBe("number");
  });
});

describe("folk avatar", () => {
  const names = Array.from({ length: 400 }, (_, i) => `Bot ${i}`);

  test("is the default: the mustard folk on a round fill, its layers inlined", () => {
    const svg = generateBoringAvatar({ name: "Researcher" });
    expect(svg).toBe(generateBoringAvatar({ name: "Researcher", variant: "folk" }));
    expect(svg).toBe(generateBoringAvatar({ name: "Researcher" }));
    expect(svg).toContain("viewBox=\"0 0 160 160\"");
    expect(svg).toContain("mask_folk_");
    expect(svg.match(/<image href="data:image\/webp;base64,/g)?.length).toBeGreaterThanOrEqual(3);
    const fill = /<rect width="160" height="160" fill="(#[0-9a-f]{6})"/.exec(svg)?.[1] ?? "";
    expect(FOLK_FILLS as readonly string[]).toContain(fill);
  });

  test("every trait varies with the name, and Randomize's salted name draws another", () => {
    const looks = names.map((name) => folkLook(hashCode(name)));
    for (const trait of ["fill", "eyes", "mouth", "accessory", "wave", "mirror"] as const) {
      expect(new Set(looks.map((look) => look[trait])).size).toBeGreaterThan(1);
    }
    expect(new Set(looks.map((look) => look.fill))).toEqual(new Set(FOLK_FILLS));
    expect(new Set(looks.map((look) => look.accessory)).size).toBe(5);
    expect(generateBoringAvatar({ name: "Writer" })).not.toBe(generateBoringAvatar({ name: "Writer_1" }));
  });

  test("a folk in headphones never waves: the raised arm would pass through the ear cup", () => {
    const withHeadphones = names.map((name) => folkLook(hashCode(name))).filter((look) => look.accessory === "headphones");
    expect(withHeadphones.length).toBeGreaterThan(0);
    expect(withHeadphones.every((look) => !look.wave)).toBe(true);
  });

  test("the style a generated avatar was drawn in reads back from it", () => {
    for (const variant of BORING_AVATAR_VARIANTS) {
      expect(generatedAvatarVariant(generateBoringAvatar({ name: "Coordinator", variant }))).toBe(variant);
    }
    expect(generatedAvatarVariant("data:image/jpeg;base64,/9j/4AAQ")).toBeNull();
    expect(generatedAvatarVariant("")).toBeNull();
    expect(generatedAvatarVariant(null)).toBeNull();
  });
});
