import { expect, test } from "bun:test";
import { connectorById } from "@real-bot/protocol";
import { asksForWorkspace, planOrder, searchPlans, type PlanProbe } from "./connector-detect.ts";

const xiaomi = connectorById("xiaomi")!;
const ok: PlanProbe = { ok: true, models: ["m"], catalog: [] };
const refused: PlanProbe = { ok: false, error: "Endpoint returned 401: Invalid API Key", status: 401 };

test("the plan the endpoint is on is tried first", () => {
  expect(planOrder(xiaomi, "").map((plan) => plan.id)).toEqual(["token-plan-cn", "token-plan-sgp", "token-plan-ams", "payg"]);
  expect(planOrder(xiaomi, "https://api.xiaomimimo.com/v1/").map((plan) => plan.id)).toEqual(["payg", "token-plan-cn", "token-plan-sgp", "token-plan-ams"]);
  expect(planOrder(xiaomi, "https://dashscope.aliyuncs.com/compatible-mode/v1").map((plan) => plan.id)[0]).toBe("token-plan-cn");
});

test("a 401 moves on; the first plan that takes the key wins and later ones are not asked", async () => {
  const asked: string[] = [];
  const outcome = await searchPlans(xiaomi.plans, async (plan) => {
    asked.push(plan.id);
    return plan.id === "token-plan-ams" ? ok : refused;
  }, () => true);
  expect(outcome).toMatchObject({ kind: "found", plan: { id: "token-plan-ams" } });
  expect(asked).toEqual(["token-plan-cn", "token-plan-sgp", "token-plan-ams"]);
});

test("every plan refusing is a refusal; anything else stops the search where it was said", async () => {
  expect(await searchPlans(xiaomi.plans, async () => refused, () => true)).toEqual({ kind: "refused" });
  const asked: string[] = [];
  const outcome = await searchPlans(xiaomi.plans, async (plan) => {
    asked.push(plan.id);
    return { ok: false, error: "Failed to connect", status: 422 };
  }, () => true);
  expect(outcome).toMatchObject({ kind: "failed", plan: { id: "token-plan-cn" }, error: "Failed to connect" });
  expect(asked).toEqual(["token-plan-cn"]);
  const noStatus = await searchPlans(xiaomi.plans, async () => ({ ok: false, error: "Not connected" }), () => true);
  expect(noStatus.kind).toBe("failed");
});

test("an answer the form no longer wants is dropped", async () => {
  let wanted = true;
  const outcome = await searchPlans(xiaomi.plans, async () => {
    wanted = false;
    return ok;
  }, () => wanted);
  expect(outcome).toEqual({ kind: "stale" });
});

test("Anthropic's refusal of a key not scoped to a workspace is recognised", () => {
  expect(asksForWorkspace("Endpoint returned 400: This API key is not scoped to a workspace, so this request must include the anthropic-workspace-id header with the ID of the workspace to use.")).toBe(true);
  expect(asksForWorkspace("Endpoint returned 400: anthropic-workspace-id is required when authenticating with an identity-linked API key; send the id of the workspace this request acts in.")).toBe(true);
  expect(asksForWorkspace("Endpoint returned 400: anthropic-workspace-id header must be a valid workspace ID.")).toBe(false);
  expect(asksForWorkspace("Endpoint returned 401: invalid x-api-key")).toBe(false);
});
