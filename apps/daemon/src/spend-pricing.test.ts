import { expect, test } from "bun:test";
import { estimateCostUsdTicks } from "./spend-pricing";
import { normalizeModelCatalog, parseStoredCatalog, serializeCatalog } from "./models";

const prices = { input: 2, output: 8, cached_input: 0.5 };

test("billing estimates use cached and output rates once, in integer USD ticks", () => {
  expect(estimateCostUsdTicks({ inputTokens: 1000, cachedTokens: 200, outputTokens: 100 }, prices)).toBe(25_000_000);
  expect(estimateCostUsdTicks({ inputTokens: 1000, cachedTokens: 0, outputTokens: 100 }, prices)).toBe(28_000_000);
  expect(estimateCostUsdTicks({ inputTokens: 1000, outputTokens: 100 }, prices)).toBe(28_000_000);
  expect(estimateCostUsdTicks({ inputTokens: 1000, cachedTokens: 200, outputTokens: 100 }, { input: 2, output: 8 })).toBe(28_000_000);
  expect(estimateCostUsdTicks({ inputTokens: 0, outputTokens: 0 }, prices)).toBe(0);
  expect(estimateCostUsdTicks({ inputTokens: 1, outputTokens: 0 }, { input: 0.000025, output: 0 })).toBe(0);
});

test("missing usage and provider-reported costs stay separate from estimates", () => {
  expect(estimateCostUsdTicks({ inputTokens: 1000 }, prices)).toBeNull();
  expect(estimateCostUsdTicks({ outputTokens: 100 }, prices)).toBeNull();
  expect(estimateCostUsdTicks({ inputTokens: 1000, outputTokens: 100 }, undefined)).toBeNull();
  for (const costUsdTicks of [0, 100]) {
    expect(estimateCostUsdTicks({ inputTokens: 1000, outputTokens: 100, costUsdTicks }, prices)).toBeNull();
  }
  expect(estimateCostUsdTicks({ inputTokens: 10, outputTokens: 1, cachedTokens: 11 }, prices)).toBeNull();
  expect(estimateCostUsdTicks({ inputTokens: Number.MAX_SAFE_INTEGER, outputTokens: 1 }, prices)).toBeNull();
});

test("catalog billing prices round-trip independently from relative routing price", () => {
  const catalog = normalizeModelCatalog([{ name: "priced", price: 4, pricing: prices }, "legacy"]);
  expect(catalog[0]).toMatchObject({ price: 4, pricing: prices });
  expect(catalog[1]).not.toHaveProperty("pricing");
  expect(parseStoredCatalog(serializeCatalog(catalog))).toEqual(catalog);
  expect(normalizeModelCatalog([{ name: "free", pricing: { input: 0, output: 0 } }])[0]?.pricing).toEqual({ input: 0, output: 0 });
  expect(normalizeModelCatalog([{ name: "cleared", pricing: null }])[0]).not.toHaveProperty("pricing");
});

test("billing prices reject partial, negative and non-finite configuration", () => {
  for (const pricing of [[], "1", {}, { input: 1 }, { input: 1, output: -1 },
    { input: "2", output: 1 }, { input: NaN, output: 1 }, { input: 1, output: Infinity },
    { input: 1, output: 2, cached_input: null }, { input: 1, output: 2, cached_input: -1 }]) {
    expect(() => normalizeModelCatalog([{ name: "bad", pricing }])).toThrow("model pricing");
  }
});
