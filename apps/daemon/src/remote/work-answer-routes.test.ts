import { expect, test } from "bun:test";
import { validateBusiness } from "./routes";

const id = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
test("the phone may answer a durable work question without selecting a target or approving a tool", () => {
  const path = `/v1/messages/${id}/work-answer`;
  expect(() => validateBusiness({ v: 1, id, method: "POST", path, body: { body: "Version 3\n保持原文" } })).not.toThrow();
  for (const body of [{}, { body: 3 }, { body: " " }, { body: "yes", work_item_id: id }, { body: "yes", lift_hold: true }, { body: "yes", action: "allow_once" }]) {
    expect(() => validateBusiness({ v: 1, id, method: "POST", path, body })).toThrow();
  }
});
