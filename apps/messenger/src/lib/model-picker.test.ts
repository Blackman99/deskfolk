import { expect, test } from "bun:test";
import { findPicked, groupModels, searchPicker, sourceCount, type PickerData } from "./model-picker.ts";

const rows = (ids: string[]) => ids.map((id) => ({ value: id, label: id }));

test("OpenCode's provider/model names group by provider, each named without it", () => {
  const groups = groupModels(rows(["alibaba-cn/deepseek-r1", "alibaba-cn/qwen3", "nvidia/glm-5.3", "openai/gpt-5.6", "plain"]));
  expect(groups.map((group) => [group.label, group.rows.map((row) => row.label)])).toEqual([
    ["alibaba-cn", ["deepseek-r1", "qwen3"]],
    ["nvidia", ["glm-5.3"]],
    ["openai", ["gpt-5.6"]],
    [null, ["plain"]],
  ]);
  // The value stays the whole name, and it is shown under the short one.
  expect(groups[0]!.rows[0]).toEqual({ value: "alibaba-cn/deepseek-r1", label: "deepseek-r1", detail: "alibaba-cn/deepseek-r1" });
});

test("a short list stays one group; a long one of plain names groups by family only when that sorts it", () => {
  expect(groupModels(rows(["gpt-5", "claude-sonnet"]))).toEqual([{ key: "", label: null, rows: rows(["gpt-5", "claude-sonnet"]) }]);
  const many = [...Array(15)].flatMap((_, i) => [`gpt-${i}`, `claude-${i}`, `gemini-${i}`]);
  expect(groupModels(rows(many)).map((group) => group.label)).toEqual(["gpt", "claude", "gemini"]);
  expect(groupModels(rows([...Array(45)].map((_, i) => `m${i}`)))).toHaveLength(1);
  expect(groupModels([])).toEqual([]);
});

const data: PickerData = {
  specials: [{ value: "", label: "Follow the default" }],
  sources: [
    { key: "endpoint:a", label: "My CPA", mark: null, groups: [{ key: "", label: null, rows: rows(["gemini-3.8-flash", "grok-4.7"]) }] },
    { key: "agent:opencode", label: "OpenCode", mark: null, groups: groupModels(rows(["xai/grok-4.7", "nvidia/glm-5.3", "openai/gpt-5.6"])) },
  ],
};

test("the row a value names is found with its source and group", () => {
  expect(findPicked(data, "")?.row.label).toBe("Follow the default");
  const picked = findPicked(data, "nvidia/glm-5.3")!;
  expect([picked.source?.label, picked.group?.label, picked.row.label]).toEqual(["OpenCode", "nvidia", "glm-5.3"]);
  expect(findPicked(data, "nope")).toBeNull();
  expect(sourceCount(data.sources[1]!)).toBe(3);
});

test("a search finds every word anywhere, names that start with it first, by source", () => {
  const found = searchPicker(data, "grok");
  expect(found.map((result) => [result.source?.label, result.rows.map((row) => row.value)])).toEqual([
    ["My CPA", ["grok-4.7"]],
    ["OpenCode", ["xai/grok-4.7"]],
  ]);
  // Words match the group and the source too, all of them.
  expect(searchPicker(data, "opencode nvidia").flatMap((result) => result.rows.map((row) => row.value))).toEqual(["nvidia/glm-5.3"]);
  expect(searchPicker(data, "follow")[0]).toEqual({ source: null, rows: [data.specials[0]!] });
  // Within one source only, and nothing for an empty query.
  expect(searchPicker(data, "grok", "agent:opencode").map((result) => result.source?.key)).toEqual(["agent:opencode"]);
  expect(searchPicker(data, "  ")).toEqual([]);
});
