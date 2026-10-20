import type { Locale } from "@real-bot/protocol";
import type { CopyShape } from "./copy/shape.ts";
import * as delegationText from "./copy/delegation.ts";
import * as groupLeadText from "./copy/group-lead.ts";
import * as routinesText from "./copy/routines.ts";
import * as calendarText from "./copy/calendar.ts";
import * as commonText from "./copy/common.ts";
import * as disconnectedText from "./copy/disconnected.ts";
import * as remoteText from "./copy/remote.ts";
import * as sidebarText from "./copy/sidebar.ts";
import * as settingsText from "./copy/settings.ts";
import * as topText from "./copy/top.ts";
import * as paneText from "./copy/pane.ts";
import * as openPlacementText from "./copy/open-placement.ts";
import * as terminalText from "./copy/terminal.ts";
import * as screenText from "./copy/screen.ts";
import * as screenWindowsText from "./copy/screen-windows.ts";
import * as streamText from "./copy/stream.ts";
import * as composerText from "./copy/composer.ts";
import * as chatText from "./copy/chat.ts";
import * as workQuestionText from "./copy/work-question.ts";
import * as controlText from "./copy/control.ts";
import * as threadText from "./copy/thread.ts";
import * as routesText from "./copy/routes.ts";
import * as traceText from "./copy/trace.ts";
import * as traceStepsText from "./copy/trace-steps.ts";
import * as planText from "./copy/plan.ts";
import * as detailText from "./copy/detail.ts";
import * as onboardingText from "./copy/onboarding.ts";
import * as sharedSkillsText from "./copy/shared-skills.ts";
import * as modelLadderText from "./copy/model-ladder.ts";
import * as claudeAgentText from "./copy/claude-agent.ts";
import * as agentsText from "./copy/agents.ts";
import * as usageText from "./copy/usage.ts";
import * as modelPickerText from "./copy/model-picker.ts";
import * as builtinModelsText from "./copy/builtin-models.ts";
import * as routingText from "./copy/routing.ts";
import * as playbooksText from "./copy/playbooks.ts";
import * as templatesText from "./copy/templates.ts";
import * as connectorsText from "./copy/connectors.ts";
import * as speechText from "./copy/speech.ts";
import * as lessonsText from "./copy/lessons.ts";
import * as promptsText from "./copy/prompts.ts";
import * as notificationsText from "./copy/notifications.ts";
import * as permissionsText from "./copy/permissions.ts";
import * as projectText from "./copy/project.ts";
import * as taskmapText from "./copy/taskmap.ts";

/** What the workspace is for (ADR 0092): where Bots' work is kept together, not a permission boundary. */
export const WORKSPACE_COPY = {
  zh: "工作区是所有 Bot 的产出集中存放、统一管理的地方，不是权限边界：Bot 能做什么由权限模式决定。",
  en: "The workspace is where every Bot's work is kept and managed together, not a permission boundary: what a Bot may do is set by its permission mode.",
} as const;

const zh = {
  delegation: delegationText.zh,
  groupLead: groupLeadText.zh,
  routines: routinesText.zh,
  calendar: calendarText.zh,
  common: commonText.zh,
  disconnected: disconnectedText.zh,
  remote: remoteText.zh,
  sidebar: sidebarText.zh,
  settings: settingsText.zh,
  top: topText.zh,
  pane: paneText.zh,
  openPlacement: openPlacementText.zh,
  terminal: terminalText.zh,
  screen: screenText.zh,
  screenWindows: screenWindowsText.zh,
  stream: streamText.zh,
  composer: composerText.zh,
  chat: chatText.zh,
  workQuestion: workQuestionText.zh,
  control: controlText.zh,
  thread: threadText.zh,
  routes: routesText.zh,
  trace: traceText.zh,
  traceSteps: traceStepsText.zh,
  plan: planText.zh,
  detail: detailText.zh,
  onboarding: onboardingText.zh,
  sharedSkills: sharedSkillsText.zh,
  modelLadder: modelLadderText.zh,
  claudeAgent: claudeAgentText.zh,
  agents: agentsText.zh,
  usage: usageText.zh,
  modelPicker: modelPickerText.zh,
  builtinModels: builtinModelsText.zh,
  routing: routingText.zh,
  playbooks: playbooksText.zh,
  templates: templatesText.zh,
  connectors: connectorsText.zh,
  speech: speechText.zh,
  lessons: lessonsText.zh,
  prompts: promptsText.zh,
  notifications: notificationsText.zh,
  permissions: permissionsText.zh,
  project: projectText.zh,
  taskmap: taskmapText.zh,
};

const en: CopyShape<typeof zh> = {
  delegation: delegationText.en,
  groupLead: groupLeadText.en,
  routines: routinesText.en,
  calendar: calendarText.en,
  common: commonText.en,
  disconnected: disconnectedText.en,
  remote: remoteText.en,
  sidebar: sidebarText.en,
  settings: settingsText.en,
  top: topText.en,
  pane: paneText.en,
  openPlacement: openPlacementText.en,
  terminal: terminalText.en,
  screen: screenText.en,
  screenWindows: screenWindowsText.en,
  stream: streamText.en,
  composer: composerText.en,
  chat: chatText.en,
  workQuestion: workQuestionText.en,
  control: controlText.en,
  thread: threadText.en,
  routes: routesText.en,
  trace: traceText.en,
  traceSteps: traceStepsText.en,
  plan: planText.en,
  detail: detailText.en,
  onboarding: onboardingText.en,
  sharedSkills: sharedSkillsText.en,
  modelLadder: modelLadderText.en,
  claudeAgent: claudeAgentText.en,
  agents: agentsText.en,
  usage: usageText.en,
  modelPicker: modelPickerText.en,
  builtinModels: builtinModelsText.en,
  routing: routingText.en,
  playbooks: playbooksText.en,
  templates: templatesText.en,
  connectors: connectorsText.en,
  speech: speechText.en,
  lessons: lessonsText.en,
  prompts: promptsText.en,
  notifications: notificationsText.en,
  permissions: permissionsText.en,
  project: projectText.en,
  taskmap: taskmapText.en,
};

export const COPY = { zh, en };

export type Copy = CopyShape<typeof zh>;

/**
 * The remote screen's words on a phone, for the computer it reached: a Mac's Screen Sharing by
 * default, a Windows PC's VNC server when its link said `host: "windows"` (`/remote/features`).
 */
export function screenCopy(t: Copy, host: "mac" | "windows"): Copy["screen"] {
  return host === "windows" ? { ...t.screen, ...t.screenWindows } : t.screen;
}

export function copyFor(locale: Locale): Copy {
  return locale === "en" ? en : zh;
}

/** Known thinking-level labels, falling back to the endpoint's own token. */
export function thinkingLevelLabel(
  labels: Record<string, string> | undefined,
  level: string,
): string {
  return labels?.[level] ?? level;
}
