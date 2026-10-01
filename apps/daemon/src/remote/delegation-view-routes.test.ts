import { expect, test } from "bun:test";
import { validateBusiness } from "./routes";

const id = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
test("paired clients may only read the persisted delegation projection of a plan or thread", () => {
  for (const entity of ["tasks", "sessions"]) {
    const path = `/v1/${entity}/${id}/delegations`;
    expect(() => validateBusiness({ v: 1, id, method: "GET", path })).not.toThrow();
    expect(() => validateBusiness({ v: 1, id, method: "GET", path, query: { wake: "true" } })).toThrow();
    expect(() => validateBusiness({ v: 1, id, method: "POST", path, body: { answer: "fake" } })).toThrow();
    expect(() => validateBusiness({ v: 1, id, method: "GET", path: `/v1/${entity}/not-an-id/delegations` })).toThrow();
  }
});
