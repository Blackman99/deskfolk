import { describe, expect, test } from "bun:test";
import {
	findNextEnabledIndex,
	findOptionByPrefix,
	normalizeOptions,
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
