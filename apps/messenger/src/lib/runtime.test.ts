import { expect, test } from "bun:test";
import type { PatchBotsModelRequest, PatchBotsModelResponse } from "@real-bot/protocol";
import { ApiError } from "./api.ts";
import { MessengerRuntime } from "./runtime.svelte.ts";
import { aBot } from "./test-fixtures.ts";

/** A runtime whose local API is a stand-in, so a method's effect on the snapshot shows directly. */
function withApi(api: Record<string, unknown>): MessengerRuntime {
  const runtime = new MessengerRuntime();
  (runtime as unknown as { api: unknown }).api = api;
  return runtime;
}

test("a bulk model change is one request; the changed Bots come back as bot.upsert events", async () => {
  const sent: PatchBotsModelRequest[] = [];
  const runtime = withApi({
    kind: "local",
    patchBotsModel: async (body: PatchBotsModelRequest): Promise<PatchBotsModelResponse> => {
      sent.push(body);
      return {
        bots: [
          aBot({ id: "b1", name: "甲", model: "grok-5", provider_id: "prov-1", thinking_level: "low" }),
          aBot({ id: "b2", name: "乙", model: "grok-5", provider_id: "prov-1", thinking_level: "low" }),
        ],
      };
    },
  });
  const before = [aBot({ id: "b1", name: "甲", model: "grok-4.6" }), aBot({ id: "b2", name: "乙" }), aBot({ id: "b3", name: "丙" })];
  runtime.snapshot = { ...runtime.snapshot, bots: before };
  const body = { bot_ids: ["b1", "b2"], model: "grok-5", provider_id: "prov-1", thinking_level: "low" };
  expect(await runtime.patchBotsModel(body)).toBeNull();
  expect(sent).toEqual([body]);
  // Like a single Bot's edit, the snapshot moves with the store's events, not the response.
  expect(runtime.snapshot.bots).toEqual(before);
});

test("a remote link has no bulk route, so nothing is sent and the change is refused", async () => {
  const sent: unknown[] = [];
  const runtime = withApi({
    kind: "remote",
    patchBotsModel: async (body: unknown) => {
      sent.push(body);
      return { bots: [] };
    },
  });
  const error = await runtime.patchBotsModel({ bot_ids: ["b1"], model: null });
  // Not a silent no-op the dialog would close on as if it had worked.
  expect(error?.code).toBe("capability_unavailable");
  expect(sent).toEqual([]);
});

test("a refused bulk change hands the error back and leaves the snapshot as it was", async () => {
  const runtime = withApi({
    kind: "local",
    patchBotsModel: async () => {
      throw new ApiError(422, "invalid_args", "model must be one of the provider models");
    },
  });
  const before = [aBot({ id: "b1", model: "grok-4.6" })];
  runtime.snapshot = { ...runtime.snapshot, bots: before };
  runtime.connection = "connected";
  const error = await runtime.patchBotsModel({ bot_ids: ["b1"], model: "nope", provider_id: null });
  expect(error?.status).toBe(422);
  expect(runtime.snapshot.bots).toEqual(before);
  // A refusal is an answer, not a lost daemon.
  expect(runtime.connection).toBe("connected");
});

test("the bulk model dialog opens over the session drawer and goes with the other sheets", () => {
  const runtime = new MessengerRuntime();
  runtime.sessionSettingsOpen = true;
  runtime.createGroupOpen = true;
  runtime.openBulkModel(["b1", "b2"]);
  expect(runtime.bulkModel).toEqual({ preselect: ["b1", "b2"] });
  expect(runtime.sessionSettingsOpen).toBe(true);
  expect(runtime.createGroupOpen).toBe(false);

  runtime.openCreateBot();
  expect(runtime.bulkModel).toBeNull();

  runtime.openBulkModel();
  expect(runtime.bulkModel).toEqual({ preselect: [] });
  runtime.closeSheets();
  expect(runtime.bulkModel).toBeNull();

  // Spend is a pane like the calendar: opening it puts the dialog away too.
  runtime.openBulkModel(["b1"]);
  runtime.openSpend();
  expect(runtime.bulkModel).toBeNull();
  runtime.openBulkModel(["b1"]);
  runtime.applyOverlay({ kind: "spend" });
  expect(runtime.bulkModel).toBeNull();
});
