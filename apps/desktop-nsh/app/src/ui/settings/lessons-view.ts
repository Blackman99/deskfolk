/** Pure helpers of `LessonsSettings` (what each lesson row says about itself). */
import type { Lesson } from "@real-bot/protocol";
import type { Copy } from "../../m/copy.ts";

export type LessonTone = "retired" | "candidate" | "adopted" | "block" | "warn";

export function lastSeen(lesson: Lesson): string | null {
  return lesson.evidence.at(-1)?.at ?? null;
}

/** A shell lesson's kind of call; a reflection's, what it is (ADR 0051). */
export function kindOf(lesson: Lesson, t: Copy): string {
  if (lesson.detector.tool === "shell") return lesson.detector.head;
  if (lesson.action === "propose_check") return t.lessons.checkProposal;
  return t.lessons.checklistAt[lesson.hook as "before_review" | "before_submit" | "before_generate"] ?? lesson.hook;
}

export function badgeOf(lesson: Lesson, t: Copy): { tone: LessonTone; label: string } {
  if (lesson.status === "retired") return { tone: "retired", label: t.lessons.retired };
  if (lesson.status === "candidate") return { tone: "candidate", label: t.lessons.candidate };
  if (lesson.detector.tool !== "shell") return { tone: "adopted", label: t.lessons.adopted };
  return lesson.action === "block" ? { tone: "block", label: t.lessons.block } : { tone: "warn", label: t.lessons.warn };
}

/** The badge's box classes, by tone (`.lesson-badge.is-*`). */
export const BADGE_CLASS: Record<LessonTone, string> = {
  retired: "bg-chip border-line",
  candidate: "bg-accent-tint border-accent-border",
  adopted: "bg-ok-bg border-ok-line",
  block: "bg-danger-bg border-danger-line",
  warn: "bg-warn-bg border-warn-line",
};
export const BADGE_TEXT: Record<LessonTone, string> = {
  retired: "text-ink-muted",
  candidate: "text-brand",
  adopted: "text-ok-text",
  block: "text-danger-text",
  warn: "text-warn-text",
};
