import { describe, expect, test } from "bun:test";
import {
  generateBoringAvatar,
  BORING_AVATAR_VARIANTS,
  hashCode,
  DEFAULT_BORING_PALETTES,
} from "@real-bot/protocol";

describe("boring-avatars SVG generator", () => {
  test("generates deterministic SVG for the same name", () => {
    const svg1 = generateBoringAvatar({ name: "Researcher" });
    const svg2 = generateBoringAvatar({ name: "Researcher" });
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

  test("all 6 variants generate valid SVG", () => {
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
