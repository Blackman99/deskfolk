import type { Locale } from "@real-bot/protocol";
import type { CopyShape } from "./copy/shape.ts";
import * as delegationText from "./copy/delegation.ts";
import * as groupLeadText from "./copy/group-lead.ts";
import * as attributionText from "./copy/attribution.ts";
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
import * as planText from "./copy/plan.ts";
import * as detailText from "./copy/detail.ts";
import * as onboardingText from "./copy/onboarding.ts";
import * as sharedSkillsText from "./copy/shared-skills.ts";
import * as modelLadderText from "./copy/model-ladder.ts";
import * as claudeAgentText from "./copy/claude-agent.ts";
import * as agentsText from "./copy/agents.ts";
import * as modelPickerText from "./copy/model-picker.ts";
import * as builtinModelsText from "./copy/builtin-models.ts";
import * as connectorsText from "./copy/connectors.ts";
import * as speechText from "./copy/speech.ts";
import * as lessonsText from "./copy/lessons.ts";
import * as promptsText from "./copy/prompts.ts";
import * as notificationsText from "./copy/notifications.ts";

/** Locked in 设置里「壳不是囚笼」写哪一句. Do not paraphrase. */
export const JAIL_COPY = {
  zh: "工作区壳把当前目录放在工作区并在启动前检查看得见的路径，不是操作系统囚笼。",
  en: "The workspace shell puts the current directory in the workspace and checks paths visible in the command before start; it is not an operating-system jail.",
} as const;

const zh = {
  delegation: delegationText.zh,
  groupLead: groupLeadText.zh,
  attribution: attributionText.zh,
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
  plan: planText.zh,
  detail: detailText.zh,
  onboarding: onboardingText.zh,
  sharedSkills: sharedSkillsText.zh,
  modelLadder: modelLadderText.zh,
  claudeAgent: claudeAgentText.zh,
  agents: agentsText.zh,
  modelPicker: modelPickerText.zh,
  builtinModels: builtinModelsText.zh,
  connectors: connectorsText.zh,
  speech: speechText.zh,
  lessons: lessonsText.zh,
  prompts: promptsText.zh,
  notifications: notificationsText.zh,
};

const en: CopyShape<typeof zh> = {
  delegation: delegationText.en,
  groupLead: groupLeadText.en,
  attribution: attributionText.en,
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
  plan: planText.en,
  detail: detailText.en,
  onboarding: onboardingText.en,
  sharedSkills: sharedSkillsText.en,
  modelLadder: modelLadderText.en,
  claudeAgent: claudeAgentText.en,
  agents: agentsText.en,
  modelPicker: modelPickerText.en,
  builtinModels: builtinModelsText.en,
  connectors: connectorsText.en,
  speech: speechText.en,
  lessons: lessonsText.en,
  prompts: promptsText.en,
  notifications: notificationsText.en,
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
