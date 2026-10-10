import { expect, test } from "bun:test";
import { BUILTIN_MODEL_ROLES, type Settings } from "@real-bot/protocol";
import { emptySnapshot } from "../snapshot.ts";
import { BUILTIN_GROUPS, builtinChosenCount, builtinModelsOf, builtinPatch, noBuiltinModels } from "./builtin-models.ts";

const base = emptySnapshot().settings;
const endpoint = { provider_id: "p1", model: "grok-4.7-build-fast" };
const claude = { runner: "claude_code" as const, model: "haiku", config_dir: null };

/** What an older daemon reports: no `builtin_models`, and the two settings of their own only when it has them. */
const legacySettings = (over: Partial<Settings> = {}): Settings => {
  const { builtin_models: _a, reader_model: _b, organizer_model: _c, ...rest } = base;
  return { ...rest, ...over };
};

test("the groups hold every built-in call once, in the order the page shows them", () => {
  expect(BUILTIN_GROUPS.map((group) => group.key)).toEqual(["reading", "organizing", "composing", "asBot"]);
  expect(BUILTIN_GROUPS.flatMap((group) => group.roles)).toEqual([...BUILTIN_MODEL_ROLES]);
});

test("a fresh snapshot starts with no call set apart", () => {
  expect(noBuiltinModels()).toEqual({
    reader: null, organizer: null, scribe: null, judge: null, composer: null,
    judgement: null, reflection: null, retrospective: null, compaction: null,
  });
  expect(base.builtin_models).toEqual(noBuiltinModels());
});

test("with builtin_models every call is there, chosen from it, and the old settings are not read", () => {
  const settings: Settings = {
    ...base,
    reader_model: endpoint,
    builtin_models: { ...noBuiltinModels(), scribe: endpoint, compaction: claude },
  };
  const view = builtinModelsOf(settings);
  expect(view.legacy).toBe(false);
  expect(view.roles).toEqual([...BUILTIN_MODEL_ROLES]);
  expect(view.chosen.scribe).toEqual(endpoint);
  expect(view.chosen.compaction).toEqual(claude);
  // The daemon mirrors reader_model; builtin_models is what says what the reader runs on.
  expect(view.chosen.reader).toBeNull();
});

test("from an older daemon only the reading and organizing models are there, chosen from their own settings", () => {
  const view = builtinModelsOf(legacySettings({ reader_model: claude, organizer_model: endpoint }));
  expect(view).toEqual({ chosen: { reader: claude, organizer: endpoint }, roles: ["reader", "organizer"], legacy: true });
  // Following the default is null, which is there; absent is a daemon that never had the setting.
  expect(builtinModelsOf(legacySettings({ reader_model: null, organizer_model: null })).roles).toEqual(["reader", "organizer"]);
  expect(builtinModelsOf(legacySettings({ reader_model: null })).roles).toEqual(["reader"]);
  expect(builtinModelsOf(legacySettings({ organizer_model: null })).roles).toEqual(["organizer"]);
  expect(builtinModelsOf(legacySettings())).toEqual({ chosen: {}, roles: [], legacy: true });
});

test("a choice is saved in the shape the daemon reads: builtin_models, or the old setting from an older daemon", () => {
  expect(builtinPatch("scribe", endpoint, false)).toEqual({ builtin_models: { scribe: endpoint } });
  expect(builtinPatch("compaction", claude, false)).toEqual({ builtin_models: { compaction: claude } });
  expect(builtinPatch("reader", null, false)).toEqual({ builtin_models: { reader: null } });
  expect(builtinPatch("organizer", endpoint, false)).toEqual({ builtin_models: { organizer: endpoint } });
  expect(builtinPatch("reader", claude, true)).toEqual({ reader_model: claude });
  expect(builtinPatch("reader", null, true)).toEqual({ reader_model: null });
  expect(builtinPatch("organizer", endpoint, true)).toEqual({ organizer_model: endpoint });
  expect(builtinPatch("organizer", null, true)).toEqual({ organizer_model: null });
});

test("the count is the calls with a model of their own", () => {
  expect(builtinChosenCount(base)).toBe(0);
  expect(builtinChosenCount({ ...base, builtin_models: { ...noBuiltinModels(), judge: endpoint, composer: claude } })).toBe(2);
  expect(builtinChosenCount({ ...base, builtin_models: { ...noBuiltinModels(), ...Object.fromEntries(BUILTIN_MODEL_ROLES.map((role) => [role, endpoint])) } })).toBe(BUILTIN_MODEL_ROLES.length);
  expect(builtinChosenCount(legacySettings({ reader_model: claude, organizer_model: null }))).toBe(1);
  expect(builtinChosenCount(legacySettings({ reader_model: endpoint, organizer_model: endpoint }))).toBe(2);
  expect(builtinChosenCount(legacySettings())).toBe(0);
});
