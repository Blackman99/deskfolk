import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { RELAY_GUIDE_COMMANDS, relayGuideUrl } from "./relay-guide.ts";

/** Every `sh` block in a guide, each line without the list indentation it may sit under. */
function shellBlocks(guide: string): string[] {
  const text = readFileSync(new URL(`../../../../../docs/${guide}`, import.meta.url), "utf8");
  return [...text.matchAll(/^[ \t]*```sh\n([\s\S]*?)^[ \t]*```/gm)].map((match) =>
    match[1]!.split("\n").map((line) => line.trimStart()).join("\n"),
  );
}

describe("the remote card's relay guide", () => {
  for (const guide of ["remote-access.md", "remote-access.zh.md"]) {
    test(`teaches the commands ${guide} gives, word for word`, () => {
      const blocks = shellBlocks(guide);
      for (const [step, command] of Object.entries(RELAY_GUIDE_COMMANDS)) {
        expect({ step, found: blocks.some((block) => block.includes(command)) }).toEqual({ step, found: true });
      }
    });
  }

  test("links to the full guide in the app's language", () => {
    expect(relayGuideUrl("zh")).toBe("https://blackman99.github.io/deskfolk/zh/remote");
    expect(relayGuideUrl("en")).toBe("https://blackman99.github.io/deskfolk/en/remote");
  });
});
