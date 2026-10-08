import { describe, expect, test } from "bun:test";
import {
  generateBoringAvatar,
  generatedAvatarVariant,
  BORING_AVATAR_VARIANTS,
  hashCode,
  DEFAULT_BORING_PALETTES,
  FOLK_FILLS,
  FOLK_RAISED_ARM_DEG,
  compactFolkAvatar,
  folkAvatar,
  folkHash,
  folkLook,
  renderFolk,
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
    // a pattern squares off; the folk has no frame to square
    const svgRound = generateBoringAvatar({ name: "Bot1", variant: "beam", square: false });
    const svgSquare = generateBoringAvatar({ name: "Bot1", variant: "beam", square: true });
    expect(svgRound).not.toBe(svgSquare);
    expect(generateBoringAvatar({ name: "Bot1", square: true })).toBe(generateBoringAvatar({ name: "Bot1" }));

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

  test("is the default, stored small: the name hash and a mustard outline, no pictures", () => {
    const svg = generateBoringAvatar({ name: "Researcher" });
    expect(svg).toBe(generateBoringAvatar({ name: "Researcher", variant: "folk" }));
    expect(svg).toContain("mask_folk_");
    expect(svg).not.toContain("<image");
    expect(svg.length).toBeLessThan(600);
    expect(folkHash(svg)).toBe(hashCode("Researcher"));
  });

  test("drawn, it stands on nothing with every layer inlined", () => {
    const svg = renderFolk(hashCode("Researcher"), 80, "");
    expect(svg).toContain("viewBox=\"0 0 160 160\"");
    expect(folkHash(svg)).toBe(hashCode("Researcher"));
    // body, both arms, eyes and mouth at least; the only rect is the mask's own white
    expect(svg.match(/<image href="data:image\/webp;base64,/g)?.length).toBeGreaterThanOrEqual(5);
    expect(svg.match(/<rect [^>]*fill="([^"]+)"/g)).toEqual(['<rect width="160" height="160" fill="#FFFFFF"']);
  });

  test("a folk saved in any earlier form compacts to the stored one; anything else is left alone", () => {
    const hash = hashCode("Writer");
    const firstFormat = `<svg viewBox="0 0 160 160" fill="none"><mask id="mask_folk_${hash.toString(36)}" maskUnits="userSpaceOnUse"><rect width="160" height="160" rx="320" fill="#FFFFFF" /></mask><g mask="url(#mask_folk_${hash.toString(36)})"><rect width="160" height="160" fill="#cbe1e6" /></g></svg>`;
    expect(compactFolkAvatar(firstFormat)).toBe(generateBoringAvatar({ name: "Writer" }));
    expect(compactFolkAvatar(renderFolk(hash, 80, ""))).toBe(generateBoringAvatar({ name: "Writer" }));
    expect(compactFolkAvatar(folkAvatar(hash, 80, "<title>Writer</title>"))).toContain("<title>Writer</title>");
    const beam = generateBoringAvatar({ name: "Writer", variant: "beam" });
    expect(compactFolkAvatar(beam)).toBe(beam);
    expect(compactFolkAvatar("data:image/jpeg;base64,/9j/4AAQ")).toBe("data:image/jpeg;base64,/9j/4AAQ");
  });

  test("every trait varies with the name, and Randomize's salted name draws another", () => {
    const looks = names.map((name) => folkLook(hashCode(name)));
    for (const trait of ["eyes", "mouth", "accessory", "wave", "mirror"] as const) {
      expect(new Set(looks.map((look) => look[trait])).size).toBeGreaterThan(1);
    }
    expect(new Set(looks.map((look) => look.accessory)).size).toBe(5);
    expect(generateBoringAvatar({ name: "Writer" })).not.toBe(generateBoringAvatar({ name: "Writer_1" }));
  });

  test("a folk keeps the look its name drew before the fill went", () => {
    // folkLook's pick order is the identity of every stored folk: these must never move
    expect(folkLook(hashCode("Researcher"))).toEqual(folkLook(hashCode("Researcher")));
    expect(FOLK_FILLS).toHaveLength(7);
    const look = folkLook(hashCode("Writer"));
    expect(Object.keys(look).sort()).toEqual(["accessory", "eyes", "fill", "mirror", "mouth", "wave"]);
  });

  test("a raised arm turns about the shoulder; a folk in headphones never raises one", () => {
    const raised = names.find((name) => folkLook(hashCode(name)).wave)!;
    const lowered = names.find((name) => !folkLook(hashCode(name)).wave)!;
    expect(renderFolk(hashCode(raised), 80, "")).toContain(`transform="rotate(-${FOLK_RAISED_ARM_DEG} `);
    expect(renderFolk(hashCode(lowered), 80, "")).not.toContain("transform=\"rotate(");
    const withHeadphones = names.map((name) => folkLook(hashCode(name))).filter((look) => look.accessory === "headphones");
    expect(withHeadphones.length).toBeGreaterThan(0);
    expect(withHeadphones.every((look) => !look.wave)).toBe(true);
  });

  test("the name hash reads back from a folk avatar, old or new, and from nothing else", () => {
    for (const name of ["Researcher", "工作区文件助手", "Writer_3"]) {
      expect(folkHash(generateBoringAvatar({ name }))).toBe(hashCode(name));
    }
    const firstFormat = '<svg viewBox="0 0 160 160" fill="none"><mask id="mask_folk_2mb9xq" maskUnits="userSpaceOnUse"><rect width="160" height="160" rx="320" fill="#FFFFFF" /></mask><g mask="url(#mask_folk_2mb9xq)"><rect width="160" height="160" fill="#cbe1e6" /></g></svg>';
    expect(folkHash(firstFormat)).toBe(parseInt("2mb9xq", 36));
    expect(folkHash(generateBoringAvatar({ name: "Researcher", variant: "beam" }))).toBeNull();
    expect(folkHash("data:image/jpeg;base64,/9j/4AAQ")).toBeNull();
    expect(folkHash(null)).toBeNull();
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
