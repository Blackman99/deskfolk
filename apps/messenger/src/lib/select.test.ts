import { describe, expect, test } from "bun:test";
import {
	filterOptions,
	findNextEnabledIndex,
	findOptionByPrefix,
	normalizeOptions,
	toggleValue,
	type SelectOption
} from "./select-options.ts";

describe("select options normalization", () => {
	test("normalizes string array", () => {
		const result = normalizeOptions(["gpt-4o", "claude-3-5"]);
		expect(result).toEqual([
			{ value: "gpt-4o", label: "gpt-4o", disabled: false },
			{ value: "claude-3-5", label: "claude-3-5", disabled: false }
		]);
	});

	test("prepends emptyLabel when provided", () => {
		const result = normalizeOptions(["gpt-4o"], "默认模型");
		expect(result).toEqual([
			{ value: "", label: "默认模型", disabled: false },
			{ value: "gpt-4o", label: "gpt-4o", disabled: false }
		]);
	});

	test("does not duplicate empty option if emptyLabel provided and options also has empty item", () => {
		const opts: SelectOption[] = [
			{ value: "", label: "custom empty" },
			{ value: "gpt-4o", label: "GPT-4o" }
		];
		const result = normalizeOptions(opts, "默认模型");
		expect(result).toEqual([
			{ value: "", label: "默认模型", disabled: false },
			{ value: "gpt-4o", label: "GPT-4o", disabled: false }
		]);
	});

	test("preserves disabled and hint properties", () => {
		const opts: SelectOption[] = [
			{ value: "m1", label: "Model 1", disabled: true, hint: "Deprecated" },
			{ value: "m2", label: "Model 2", hint: "Fast" }
		];
		const result = normalizeOptions(opts);
		expect(result).toEqual([
			{ value: "m1", label: "Model 1", disabled: true, hint: "Deprecated" },
			{ value: "m2", label: "Model 2", disabled: false, hint: "Fast" }
		]);
	});
});

describe("select keyboard navigation helpers", () => {
	const testOptions = normalizeOptions([
		{ value: "1", label: "Alpha" },
		{ value: "2", label: "Beta", disabled: true },
		{ value: "3", label: "Gamma" },
		{ value: "4", label: "Delta" }
	]);

	test("steps down skipping disabled item", () => {
		// From 0 (Alpha) -> 1 is disabled -> should be 2 (Gamma)
		expect(findNextEnabledIndex(testOptions, 0, 1)).toBe(2);
	});

	test("wraps around to the beginning", () => {
		// From 3 (Delta) -> next should be 0 (Alpha)
		expect(findNextEnabledIndex(testOptions, 3, 1)).toBe(0);
	});

	test("steps up skipping disabled item", () => {
		// From 2 (Gamma) -> 1 is disabled -> should be 0 (Alpha)
		expect(findNextEnabledIndex(testOptions, 2, -1)).toBe(0);
	});

	test("wraps around backward from top to bottom", () => {
		// From 0 (Alpha) -> previous should be 3 (Delta)
		expect(findNextEnabledIndex(testOptions, 0, -1)).toBe(3);
	});

	test("findOptionByPrefix matches case-insensitively", () => {
		expect(findOptionByPrefix(testOptions, "g")).toBe(2);
		expect(findOptionByPrefix(testOptions, "DEL")).toBe(3);
		expect(findOptionByPrefix(testOptions, "z")).toBe(-1);
	});

	test("findOptionByPrefix ignores disabled options", () => {
		// Beta is disabled, so searching for 'b' returns -1
		expect(findOptionByPrefix(testOptions, "b")).toBe(-1);
	});
});

describe("multi-select helpers", () => {
	const bots = normalizeOptions([
		{ value: "b1", label: "剪辑师", hint: "剪片子" },
		{ value: "b2", label: "Writer", hint: "收集资料" },
		{ value: "b3", label: "调色", disabled: true }
	]);

	test("an empty query keeps the whole list, as a copy", () => {
		const all = filterOptions(bots, "   ");
		expect(all).toEqual(bots);
		expect(all).not.toBe(bots as never);
	});

	test("the query matches inside the label, not only at its head", () => {
		expect(filterOptions(bots, "辑").map((o) => o.value)).toEqual(["b1"]);
	});

	test("the query matches the hint and the value too, case-insensitively", () => {
		expect(filterOptions(bots, "资料").map((o) => o.value)).toEqual(["b2"]);
		expect(filterOptions(bots, "WRITER").map((o) => o.value)).toEqual(["b2"]);
		expect(filterOptions(bots, "b3").map((o) => o.value)).toEqual(["b3"]);
	});

	test("a query that matches nothing comes back empty", () => {
		expect(filterOptions(bots, "没有这个人")).toEqual([]);
	});

	test("toggling adds at the end and removes in place", () => {
		expect(toggleValue([], "b1")).toEqual(["b1"]);
		expect(toggleValue(["b1"], "b2")).toEqual(["b1", "b2"]);
		expect(toggleValue(["b1", "b2"], "b1")).toEqual(["b2"]);
	});

	test("toggling leaves the list it was given alone", () => {
		const held = ["b1"];
		expect(toggleValue(held, "b2")).toEqual(["b1", "b2"]);
		expect(held).toEqual(["b1"]);
	});
});
