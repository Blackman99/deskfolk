import { expect, test } from "bun:test";
import {
  formatSkillUses,
  mapCreateBotError,
  mapCreateGroupError,
  mapSkillError,
  parseSkillUses,
  pinnableThinkingLevels,
  planCreateBot,
  planCreateGroup,
  planSkill,
} from "./create-form.ts";

test("a pinned thinking level rides along; blank is null; an unknown level does not produce a request", () => {
  const base = { name: "Researcher", duties: "read", boundaries: "stay", model: "" };
  expect(planCreateBot({ ...base, thinkingLevel: "high" })).toMatchObject({
    ok: true,
    body: { thinking_level: "high" },
  });
  expect(planCreateBot({ ...base, thinkingLevel: "" })).toMatchObject({
    ok: true,
    body: { thinking_level: null },
  });
  const omitted = planCreateBot(base);
  expect(omitted.ok).toBe(true);
  if (omitted.ok) expect("thinking_level" in omitted.body).toBe(false);
  expect(planCreateBot({ ...base, thinkingLevel: "xhigh" })).toMatchObject({
    ok: true,
    body: { thinking_level: "xhigh" },
  });
  expect(planCreateBot({ ...base, thinkingLevel: "high!" })).toEqual({
    ok: false,
    errors: { thinkingLevel: "invalid" },
  });
  expect(mapCreateBotError(422, "thinking_level must be one the pinned model supports")).toEqual({
    thinkingLevel: "invalid",
  });
});

test("pinnable thinking levels follow the picked model's catalog, or every level when nothing is pinned", () => {
  const providers = [
    {
      id: "p1",
      model_catalog: [
        { name: "cheap-chat", thinking_levels: ["none", "low"] as const },
        { name: "code-pro", thinking_levels: ["high", "medium"] as const },
        { name: "grok-4.6", thinking_levels: ["low", "high", "xhigh"] as const },
      ],
    },
    { id: "p2", model_catalog: [{ name: "code-pro", thinking_levels: ["low"] as const }] },
  ];
  expect(pinnableThinkingLevels("", providers)).toEqual(["none", "low", "medium", "high", "xhigh"]);
  expect(pinnableThinkingLevels("p1::cheap-chat", providers)).toEqual(["none", "low"]);
  expect(pinnableThinkingLevels("p1::code-pro", providers)).toEqual(["medium", "high"]);
  expect(pinnableThinkingLevels("p1::grok-4.6", providers)).toEqual(["low", "high", "xhigh"]);
  expect(pinnableThinkingLevels("code-pro", providers)).toEqual(["low", "medium", "high"]);
  expect(pinnableThinkingLevels("p1::unknown", providers)).toEqual(["none", "low", "medium", "high"]);
});

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

test("whitespace skill fields do not produce a POST", () => {
  expect(planSkill({ name: "  ", description: "", body: "\t", uses: "", enabled: true })).toEqual({
    ok: false,
    errors: { name: "empty", description: "empty", body: "empty" },
  });
});

test("trimmed skill fields produce the POST body", () => {
  expect(
    planSkill({
      name: " Commits ",
      description: " when committing ",
      body: " use conventional commits ",
      uses: " GitHub, github ，slack\n time ",
      enabled: false,
    }),
  ).toEqual({
    ok: true,
    body: {
      name: "Commits",
      description: "when committing",
      body: "use conventional commits",
      uses: ["GitHub", "slack", "time"],
      enabled: false,
    },
  });
});

test("skill uses round-trip between the typed list and the array", () => {
  expect(parseSkillUses("")).toEqual([]);
  expect(parseSkillUses(" , ；\n")).toEqual([]);
  expect(formatSkillUses(["github", "slack"])).toBe("github, slack");
  expect(parseSkillUses(formatSkillUses(["github", "slack"]))).toEqual(["github", "slack"]);
});

test("maps daemon skill name-conflict onto the name field", () => {
  expect(mapSkillError(409, "that skill name is already used")).toEqual({ name: "conflict" });
  expect(mapSkillError(422, "name is required")).toEqual({ name: "empty" });
  expect(mapSkillError(422, "description is required")).toEqual({ description: "empty" });
  expect(mapSkillError(422, "body is required")).toEqual({ body: "empty" });
  expect(mapSkillError(422, "a bot can have at most 32 skills")).toEqual({ top: true });
});
