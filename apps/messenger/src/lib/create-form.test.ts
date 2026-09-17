import { expect, test } from "bun:test";
import { mapCreateBotError, mapCreateGroupError, planCreateBot, planCreateGroup } from "./create-form.ts";

test("whitespace name, duties, and boundaries do not produce a POST", () => {
  expect(
    planCreateBot({ name: "  ", duties: "", boundaries: "\t", model: "" }),
  ).toEqual({
    ok: false,
    errors: { name: "empty", duties: "empty", boundaries: "empty" },
  });
});

test("trimmed bot fields produce the POST body; blank model is null", () => {
  expect(
    planCreateBot({
      name: " Researcher ",
      duties: " read sources ",
      boundaries: " stay in the workspace ",
      avatar: " data:image/jpeg;base64,abc ",
      model: "",
    }),
  ).toEqual({
    ok: true,
    body: {
      name: "Researcher",
      duties: "read sources",
      boundaries: "stay in the workspace",
      avatar: "data:image/jpeg;base64,abc",
      model: null,
      provider_id: null,
    },
  });
});

test("a listed model is sent; an unknown model does not produce a POST", () => {
  expect(
    planCreateBot(
      {
        name: "Researcher",
        duties: "read",
        boundaries: "stay",
        model: "deepseek-v4-pro",
      },
      ["grok-4.5", "deepseek-v4-pro"],
    ),
  ).toEqual({
    ok: true,
    body: {
      name: "Researcher",
      duties: "read",
      boundaries: "stay",
      model: "deepseek-v4-pro",
      provider_id: null,
    },
  });
  expect(
    planCreateBot(
      {
        name: "Researcher",
        duties: "read",
        boundaries: "stay",
        model: "nope",
      },
      ["grok-4.5"],
    ),
  ).toEqual({
    ok: false,
    errors: { model: "invalid" },
  });
});

test("an encoded provider model is sent with provider_id", () => {
  expect(
    planCreateBot(
      {
        name: "Researcher",
        duties: "read",
        boundaries: "stay",
        model: "p1::gpt-4o",
      },
      ["p1::gpt-4o", "p2::deepseek-chat"],
    ),
  ).toEqual({
    ok: true,
    body: {
      name: "Researcher",
      duties: "read",
      boundaries: "stay",
      model: "gpt-4o",
      provider_id: "p1",
    },
  });
});

test("empty group name and fewer than two members do not produce a POST", () => {
  expect(planCreateGroup({ name: "   ", members: ["a"] })).toEqual({
    ok: false,
    errors: { name: "empty", members: "too_few" },
  });
});

test("duplicate member ids still count as one bot", () => {
  expect(planCreateGroup({ name: "Brief", members: ["a", "a"] })).toEqual({
    ok: false,
    errors: { members: "too_few" },
  });
});

test("trimmed group name and two distinct members produce the POST body", () => {
  expect(planCreateGroup({ name: " Brief ", members: ["b", "a", "b"] })).toEqual({
    ok: true,
    body: { name: "Brief", members: ["b", "a"] },
  });
});

test("maps daemon name-conflict onto the name field", () => {
  expect(mapCreateBotError(409, "that name is already used")).toEqual({ name: "conflict" });
  expect(mapCreateBotError(422, "name is required")).toEqual({ name: "empty" });
  expect(mapCreateBotError(422, "duties must be a string")).toEqual({ top: true });
  expect(mapCreateBotError(422, "model must be one of endpoint_models")).toEqual({
    model: "invalid",
  });
});

test("maps daemon group member and name failures onto the locked kinds", () => {
  expect(mapCreateGroupError(422, "name is required")).toEqual({ name: "empty" });
  expect(mapCreateGroupError(422, "a group needs at least two bots")).toEqual({
    members: "too_few",
  });
  expect(mapCreateGroupError(422, "members must include at least two bots")).toEqual({
    members: "too_few",
  });
  expect(mapCreateGroupError(404, "bot not found")).toEqual({ top: true });
});
