import type { BuiltinPlaybookId } from "@real-bot/protocol";

/**
 * Bot templates (ADR 0085): ready teammates for each built-in engine, drawn from the Bots used most
 * so far, for first launch and the new-Bot sheet. Their words are in `copy/templates.ts`; a
 * template is only a starting draft, changed before it is made.
 */
export const BOT_TEMPLATE_IDS = [
  "assistant", "translator", "researcher",
  "director", "writer", "subtitler", "reviewer",
  "developer", "frontend", "backend", "designer",
] as const;
export type BotTemplateId = (typeof BOT_TEMPLATE_IDS)[number];

export type BotTemplate = {
  id: BotTemplateId;
  playbook: BuiltinPlaybookId;
  /** Leads the group made of a team (its confirmed lead), when there is one. */
  lead: boolean;
  /** Ticked to begin with. */
  preselected: boolean;
};

export const BOT_TEMPLATES: readonly BotTemplate[] = [
  { id: "assistant", playbook: "general", lead: true, preselected: true },
  { id: "translator", playbook: "general", lead: false, preselected: false },
  { id: "researcher", playbook: "general", lead: false, preselected: false },
  // One director and you reviewing worked better than a reviewer Bot (ADR 0085): not ticked.
  { id: "director", playbook: "video", lead: true, preselected: true },
  { id: "writer", playbook: "video", lead: false, preselected: true },
  { id: "subtitler", playbook: "video", lead: false, preselected: true },
  { id: "reviewer", playbook: "video", lead: false, preselected: false },
  // Six Bots on one dev group each took up every line: one to begin with.
  { id: "developer", playbook: "coding", lead: true, preselected: true },
  { id: "frontend", playbook: "coding", lead: false, preselected: false },
  { id: "backend", playbook: "coding", lead: false, preselected: false },
  { id: "designer", playbook: "coding", lead: false, preselected: false },
];

export function templatesFor(playbook: string): BotTemplate[] {
  return BOT_TEMPLATES.filter((template) => template.playbook === playbook);
}
