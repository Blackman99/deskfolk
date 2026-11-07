import { afterEach, expect, test } from "bun:test";
import { MessengerRuntime } from "./runtime.svelte.ts";

const runtimes: MessengerRuntime[] = [];
afterEach(() => { for (const runtime of runtimes.splice(0)) runtime.destroy(); });

const settings = (over: Record<string, unknown> = {}) => ({
  event: "settings.changed", occurred_at: "t", workspace_path: "/ws", endpoint_base_url: "https://api.example/v1",
  endpoint_key_set: true, endpoint_models: ["m1"], endpoint_model_catalog: [], endpoint_default_model: "m1",
  default_provider_id: "p1", launch_at_login: true, locale: "zh", theme: "system", wizard_complete: false, ...over,
});

test("a settings change about something else leaves the drafts being edited; a saved value that changed replaces its own", () => {
  const runtime = new MessengerRuntime();
  runtimes.push(runtime);
  const ingest = (event: unknown) => (runtime as unknown as { ingest: (event: unknown) => void }).ingest(event);
  ingest(settings());
  expect(runtime.endpointModelsText).toBe("m1");
  expect(runtime.workspacePath).toBe("/ws");
  // Picking models in setup: nothing saved yet.
  runtime.endpointModelsText = "alpha\nbeta";
  runtime.endpointDefaultModel = "alpha";
  // The theme changes elsewhere (or setup's own earlier save arrives late): the picks stay.
  ingest(settings({ theme: "dark" }));
  expect(runtime.endpointModelsText).toBe("alpha\nbeta");
  expect(runtime.endpointDefaultModel).toBe("alpha");
  // Another device saves new models: those follow it, the untouched default draft stays.
  ingest(settings({ endpoint_models: ["m1", "m2"] }));
  expect(runtime.endpointModelsText).toBe("m1\nm2");
  expect(runtime.endpointDefaultModel).toBe("alpha");
});
