import { expect, test } from "bun:test";
import type { ConsultMember } from "@real-bot/protocol";
import { canAddMember, withMember, withoutMember, withSwitch } from "./consult.ts";

const opus: ConsultMember = { agent: "claude_code", model: "opus", effort: null };
const haiku: ConsultMember = { agent: "claude_code", model: "haiku", effort: null };
const codex: ConsultMember = { agent: "codex", model: null, effort: "high" };
const grok: ConsultMember = { agent: "grok", model: null, effort: null };

test("the first member turns the switch on, and the same agent on another model is another consultant", () => {
  const one = withMember(null, opus);
  expect(one).toEqual({ on: true, members: [opus] });
  expect(withMember(one, haiku).members).toEqual([opus, haiku]);
});

test("the same agent, model and level is added once", () => {
  const one = withMember(null, opus);
  expect(canAddMember(one, opus)).toBe(false);
  expect(canAddMember(one, { ...opus, config_dir: null })).toBe(false);
  expect(withMember(one, opus)).toBe(one);
});

test("the same agent and model on two different accounts are two consultants", () => {
  const opusWork: ConsultMember = { ...opus, config_dir: "/Users/me/.claude-work" };
  const one = withMember(null, opus);
  expect(canAddMember(one, opusWork)).toBe(true);
  const two = withMember(one, opusWork);
  expect(two.members).toEqual([opus, opusWork]);
  expect(canAddMember(two, opusWork)).toBe(false);
});

test("at most three members", () => {
  const three = withMember(withMember(withMember(null, opus), haiku), codex);
  expect(three.members).toHaveLength(3);
  expect(canAddMember(three, grok)).toBe(false);
  expect(withMember(three, grok)).toBe(three);
});

test("removing the last member turns the switch off; removing another keeps it on", () => {
  const two = withMember(withMember(null, opus), haiku);
  const one = withoutMember(two, 0);
  expect(one).toEqual({ on: true, members: [haiku] });
  expect(withoutMember(one, 0)).toEqual({ on: false, members: [] });
  expect(withoutMember(two, 5)).toBe(two);
});

test("the switch goes on only with members, and off keeps them", () => {
  expect(withSwitch(null, true)).toEqual({ on: false, members: [] });
  const two = withMember(withMember(null, opus), haiku);
  const off = withSwitch(two, false);
  expect(off).toEqual({ on: false, members: [opus, haiku] });
  expect(withSwitch(off, true)).toEqual(two);
});
