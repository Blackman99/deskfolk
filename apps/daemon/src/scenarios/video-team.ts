/**
 * The cast the incident fixtures replay (ADR 0040, F-a…F-g and the rest): the video group of
 * 2026-09-27…29, where 视频导演 generates the shots and cuts the master, 审片员 reviews them and
 * 编剧分镜师 writes the boards, and the plans they worked on. The names and the lines are the
 * incidents'; everything the Bots answer is scripted, and no real data is in here.
 */
import type { Bot } from "@real-bot/protocol";
import { parsePlanSpec, type PlanSpec, type Task } from "../store";
import type { Scenario } from "../test-kit/scenario";

export type VideoTeam = { director: Bot; reviewer: Bot; writer: Bot; room: string };

/** The three Bots and the group they share with you. */
export function videoTeam(h: Scenario): VideoTeam {
  const [director, reviewer, writer] = h.createBots(
    { name: "视频导演", duties: "按分镜生成镜头，剪辑，出母带" },
    { name: "审片员", duties: "逐镜审片，放行或打回" },
    { name: "编剧分镜师", duties: "写剧本和分镜" },
  );
  const room = h.group("AI影视创作组", [director!, reviewer!, writer!]);
  return { director: director!, reviewer: reviewer!, writer: writer!, room };
}

/** A plan's spec: the goal, and whatever else is given; the rest empty and the plan active. */
export function planSpec(goal: string, over: Partial<PlanSpec> = {}): PlanSpec {
  return {
    kind: "动画成片",
    goal,
    acceptance: [],
    rules: [],
    process: [],
    progress: { done: [], open: [], blocked: [] },
    status: "active",
    ...over,
  };
}

/** A plan opened in `session` with its spec, the way the organizer's filing leaves one. */
export function openPlan(h: Scenario, session: string, title: string, spec: PlanSpec): Task {
  return h.store.openTask({ sessionId: session, title, spec });
}

/** The rules of a plan as every turn working in it reads them. */
export function rulesOf(h: Scenario, taskId: string): string[] {
  return parsePlanSpec(h.store.getTask(taskId).spec)?.rules ?? [];
}

/** How many `submit_video` calls reached the media server with a prompt naming `shot`. */
export function submitsOf(h: Scenario, shot: string): number {
  return h.mcpCalls().filter((row) => row.tool === "submit_video" && String(row.args.prompt ?? "").includes(shot)).length;
}
