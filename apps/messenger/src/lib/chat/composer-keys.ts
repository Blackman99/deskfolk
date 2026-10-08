import type { SessionSummary } from "@real-bot/protocol";
import type { SessionView } from "../session-view.svelte.ts";
import { insertComposerNewline } from "./composer-editor.ts";
import { COMPOSER_IME_IDLE, composerImeKeyAction, type ComposerImeState } from "./composer-ime.ts";
import type { ComposerMentions } from "./composer-mentions.svelte.ts";
import { handleEditorBackspace, handleEditorDelete } from "./mention-chips.ts";

/** What a key press in the box reads and drives in the composer around it; each is read when needed, so it stays live. */
export type ComposerKeyContext = {
  composerIme: () => ComposerImeState;
  setComposerIme: (next: ComposerImeState) => void;
  lockedComposer: () => boolean;
  selected: () => SessionSummary | null;
  mentions: ComposerMentions;
  onEditLast: () => (() => boolean) | undefined;
  hasContent: () => boolean;
  view: () => SessionView | null;
  editorEl: () => HTMLDivElement | null;
  syncDraftFromEditor: () => void;
  checkMentionTrigger: () => void;
  send: () => Promise<void>;
};

export function handleComposerKey(ev: KeyboardEvent, ctx: ComposerKeyContext): void {
  const mentions = ctx.mentions;
  const imeAction = composerImeKeyAction(
    {
      isComposing: ev.isComposing,
      key: ev.key,
      keyCode: ev.keyCode,
      which: ev.which,
      shiftKey: ev.shiftKey,
      metaKey: ev.metaKey,
      ctrlKey: ev.ctrlKey,
    },
    ctx.composerIme(),
    performance.now(),
  );
  if (imeAction === "swallow") {
    ev.preventDefault();
    ctx.setComposerIme(COMPOSER_IME_IDLE);
    return;
  }
  if (imeAction === "ignore" || ctx.lockedComposer() || !ctx.selected()) return;
  if (mentions.showMentionPopup) {
    if (mentions.mentionCandidates.length > 0) {
      if (ev.key === "ArrowDown") {
        ev.preventDefault();
        ev.stopPropagation();
        const next = (mentions.mentionHighlightIndex + 1) % mentions.mentionCandidates.length;
        mentions.mentionHighlightIndex = next;
        mentions.scrollMentionHighlightIntoView(next);
        return;
      }
      if (ev.key === "ArrowUp") {
        ev.preventDefault();
        ev.stopPropagation();
        const next =
          (mentions.mentionHighlightIndex - 1 + mentions.mentionCandidates.length) % mentions.mentionCandidates.length;
        mentions.mentionHighlightIndex = next;
        mentions.scrollMentionHighlightIntoView(next);
        return;
      }
      if (ev.key === "Enter" || ev.key === "Tab") {
        ev.preventDefault();
        ev.stopPropagation();
        const candidate = mentions.mentionCandidates[mentions.mentionHighlightIndex];
        if (candidate) {
          mentions.selectMentionCandidate(candidate);
        }
        return;
      }
    }
    if (ev.key === "Escape") {
      ev.preventDefault();
      ev.stopPropagation();
      mentions.showMentionPopup = false;
      mentions.mentionDismissed = true;
      return;
    }
  }

  // ↑ in an empty box opens your newest line here for changing, as in other chat apps (ADR 0063).
  const onEditLast = ctx.onEditLast();
  if (
    ev.key === "ArrowUp" &&
    !ev.shiftKey && !ev.altKey && !ev.metaKey && !ev.ctrlKey &&
    onEditLast &&
    !ctx.hasContent() &&
    !(ctx.view()?.draft ?? "").trim()
  ) {
    if (onEditLast()) {
      ev.preventDefault();
      return;
    }
  }

  const editorEl = ctx.editorEl();
  if (ev.key === "Backspace" && editorEl) {
    if (handleEditorBackspace(editorEl)) {
      ev.preventDefault();
      ev.stopPropagation();
      ctx.syncDraftFromEditor();
      ctx.checkMentionTrigger();
      return;
    }
  }

  if (ev.key === "Delete" && editorEl) {
    if (handleEditorDelete(editorEl)) {
      ev.preventDefault();
      ev.stopPropagation();
      ctx.syncDraftFromEditor();
      ctx.checkMentionTrigger();
      return;
    }
  }

  if ((ev.key === "Enter" && (ev.metaKey || ev.ctrlKey)) || (ev.key === "Enter" && !ev.shiftKey)) {
    ev.preventDefault();
    void ctx.send();
    return;
  }

  if (ev.key === "Enter" && ev.shiftKey) {
    ev.preventDefault();
    if (editorEl) insertComposerNewline(editorEl);
    ctx.syncDraftFromEditor();
    return;
  }
}
