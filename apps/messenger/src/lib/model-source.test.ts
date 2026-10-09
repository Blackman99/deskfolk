import { expect, test } from "bun:test";
import { CONNECTORS, type Provider } from "@real-bot/protocol";
import { copyFor } from "./copy.ts";
import { claudeAgentSource, endpointModelOptions, endpointSource } from "./model-source.ts";
import Select from "./Select.svelte";
import { click, render } from "./test-render.ts";

const t = copyFor("zh");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("every address of every built-in connector is marked as that connector, with its name", () => {
  for (const connector of CONNECTORS) {
    for (const plan of connector.plans) {
      expect(endpointSource({ base_url: plan.baseUrl, api_format: connector.apiFormat }, t)).toEqual({
        kind: "connector",
        id: connector.id,
        name: t.connectors.name[connector.id],
      });
    }
  }
});

test("any other endpoint is Custom: another address, a model server on this computer, or a connector's address in the other format", () => {
  const custom = { kind: "custom", name: t.connectors.customMark };
  expect(endpointSource({ base_url: "https://cpa.example.com/v1", api_format: "openai" }, t)).toEqual(custom);
  expect(endpointSource({ base_url: "http://localhost:11434/v1" }, t)).toEqual(custom);
  expect(endpointSource({ base_url: "https://api.anthropic.com", api_format: "openai" }, t)).toEqual(custom);
  expect(endpointSource({ base_url: null }, t)).toEqual(custom);
  expect(claudeAgentSource(t)).toEqual({ kind: "claude-agent", name: t.claudeAgent.title });
});

test("a picker's rows are the models by name, the endpoint beside them once there are several, each marked", () => {
  const providers = [
    { id: "p1", name: "My CPA", base_url: "https://cpa.example.com/v1", api_format: "openai", models: ["grok", "gemini"] },
    { id: "p2", name: "小米", base_url: "https://token-plan-cn.xiaomimimo.com/v1", api_format: "openai", models: ["mimo"] },
  ] as unknown as Provider[];
  const rows = endpointModelOptions(providers, t, (id, model) => `${id}/${model}`);
  expect(rows.map((row) => [row.value, row.label, row.hint, row.source?.kind])).toEqual([
    ["p1/grok", "grok", "My CPA", "custom"],
    ["p1/gemini", "gemini", "My CPA", "custom"],
    ["p2/mimo", "mimo", "小米", "connector"],
  ]);
  // One endpoint needs no name beside its models.
  expect(endpointModelOptions(providers.slice(1), t, (_, model) => model)[0]?.hint).toBeUndefined();
});

test("the picker draws each row's mark, and the chosen one's on the closed picker; the row's text stays the model's", async () => {
  const providers = [
    { id: "p1", name: "My CPA", base_url: "https://cpa.example.com/v1", api_format: "openai", models: ["grok"] },
    { id: "p2", name: "Anthropic", base_url: "https://api.anthropic.com", api_format: "anthropic", models: ["claude-opus-5"] },
  ] as unknown as Provider[];
  const options = endpointModelOptions(providers, t, (id, model) => `${id}/${model}`);
  const view = render(Select, { value: "p2/claude-opus-5", options });
  const trigger = view.host.querySelector(".real-select-trigger")!;
  expect(trigger.querySelector("[data-model-source]")?.getAttribute("data-model-source")).toBe("anthropic");
  expect(trigger.querySelector(".connector-logo.is-anthropic")).toBeTruthy();
  expect(trigger.querySelector(".real-select-value-hint")?.textContent).toBe("Anthropic");
  click(trigger);
  await sleep(0);
  const rows = [...view.host.querySelectorAll(".real-select-option")];
  expect(rows.map((row) => row.querySelector("[data-model-source]")?.getAttribute("data-model-source"))).toEqual(["custom", "anthropic"]);
  expect(rows[0]!.querySelector(".model-source-custom")?.getAttribute("data-text")).toBe("Custom");
  expect(rows[0]!.textContent?.replace(/\s+/g, " ").trim()).toBe("grok My CPA");
  view.close();
});
