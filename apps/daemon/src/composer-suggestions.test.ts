import { expect, test } from "bun:test";
import { parseComposerSuggestions } from "./composer-suggestions";
import { COMPOSER_SUGGEST_SYSTEM } from "./prompts/composer-suggestions";

const ROSTER = ["导演", "分镜师", "Researcher"];

test("composer suggest system stays a locked JSON-only short call", () => {
  expect(COMPOSER_SUGGEST_SYSTEM.includes("{")).toBe(false);
  expect(COMPOSER_SUGGEST_SYSTEM).toContain("只输出一个 JSON 对象");
  expect(COMPOSER_SUGGEST_SYSTEM).toContain("不要 tool-call");
  expect(COMPOSER_SUGGEST_SYSTEM).toContain("@everyone");
  expect(COMPOSER_SUGGEST_SYSTEM).toContain("members");
});

test("parseComposerSuggestions keeps drafts and drops unknown @", () => {
  const parsed = parseComposerSuggestions(
    `here you go:
\`\`\`json
{
  "suggestions": [
    { "label": "让导演收口", "prompt": "@导演 按现在的分镜出一版成片节奏" },
    { "label": "叫醒全员", "prompt": "@everyone 请各自报当前进度" },
    { "label": "幻觉点名", "prompt": "@不存在的人 继续" },
    { "label": "重复", "prompt": "@导演 按现在的分镜出一版成片节奏" },
    { "label": "", "prompt": "  " }
  ]
}
\`\`\``,
    ROSTER,
  );
  expect(parsed.map((row) => row.prompt)).toEqual([
    "@导演 按现在的分镜出一版成片节奏",
    "@everyone 请各自报当前进度",
  ]);
  expect(parsed[0]!.label).toBe("让导演收口");
  expect(parsed[0]!.id.length).toBeGreaterThan(0);
});

test("parseComposerSuggestions returns empty on junk", () => {
  expect(parseComposerSuggestions("no json here", ROSTER)).toEqual([]);
  expect(parseComposerSuggestions('{"suggestions": "nope"}', ROSTER)).toEqual([]);
  expect(parseComposerSuggestions("[]", ROSTER)).toEqual([]);
});
