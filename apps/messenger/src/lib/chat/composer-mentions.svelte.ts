import type { Bot, SessionSummary } from "@real-bot/protocol";
import { isOutside } from "../click-outside.ts";
import type { Copy } from "../copy.ts";
import { getTextBeforeCaret, insertMentionChipAtCaret } from "./mention-chips.ts";
import { detectMentionTrigger, scrollTopToRevealRect } from "./mention-popup.ts";

export type MentionCandidate = {
  id: string;
  name: string;
  isEveryone: boolean;
  avatar?: string | null;
  duties?: string;
};

/** What the mention popup reads from the composer around it; each is read when needed, so it stays live. */
export type ComposerMentionsDeps = {
  selected: () => SessionSummary | null;
  editorEl: () => HTMLDivElement | null;
  fileDrop: () => boolean;
  botsById: () => Map<string, Bot>;
  visibleBots: () => Bot[];
  groupPresent: () => string[];
  t: () => Copy;
  syncDraftFromEditor: () => void;
};

/** The @-mention popup's state: when it opens, who it offers, and what picking one does to the editor. */
export class ComposerMentions {
  private readonly deps: ComposerMentionsDeps;

  showMentionPopup = $state(false);

  mentionQuery = $state("");

  mentionAnchorIndex = $state(-1);

  mentionHighlightIndex = $state(0);

  mentionDismissed = $state(false);

  mentionPopupEl = $state<HTMLDivElement | null>(null);

  mentionCandidates = $derived.by<MentionCandidate[]>(() => {
    if (!this.showMentionPopup) return [];
    const q = this.mentionQuery.toLowerCase();
    const results: MentionCandidate[] = [];
    const isGroup = this.deps.selected()?.kind === "group";
    if (isGroup && "everyone".includes(q)) {
      results.push({
        id: "everyone",
        name: "everyone",
        isEveryone: true,
        duties: this.deps.t().chat.mentionTooltip,
      });
    }
    const botsById = this.deps.botsById();
    const botsList = isGroup
      ? this.deps.groupPresent().map((id) => botsById.get(id)).filter((b): b is Bot => Boolean(b))
      : this.deps.visibleBots();
    for (const b of botsList) {
      if (b.name.toLowerCase().includes(q) || (b.duties && b.duties.toLowerCase().includes(q))) {
        results.push({
          id: b.id,
          name: b.name,
          isEveryone: false,
          avatar: b.avatar,
          duties: b.duties,
        });
      }
    }
    return results;
  });

  constructor(deps: ComposerMentionsDeps) {
    this.deps = deps;

    /**
     * Another conversation in this composer clears whatever was half-typed into the mention popup.
     * This one's, not the selected one's: clicking into another pane is not a change here.
     */
    $effect(() => {
      void this.deps.selected()?.id;
      this.showMentionPopup = false;
      this.mentionDismissed = false;
      this.mentionQuery = "";
      this.mentionAnchorIndex = -1;
    });

    $effect(() => {
      if (this.mentionHighlightIndex >= this.mentionCandidates.length && this.mentionCandidates.length > 0) {
        this.mentionHighlightIndex = this.mentionCandidates.length - 1;
      }
    });
  }

  scrollMentionHighlightIntoView = (index = this.mentionHighlightIndex): void => {
    const popup = this.mentionPopupEl;
    if (!popup) return;
    const item = popup.querySelectorAll<HTMLElement>(".autocomplete-item")[index];
    if (!item) return;
    const popupRect = popup.getBoundingClientRect();
    const itemRect = item.getBoundingClientRect();
    popup.scrollTop = scrollTopToRevealRect(
      popup.scrollTop,
      popupRect.top,
      popupRect.bottom,
      itemRect.top,
      itemRect.bottom
    );
  };

  checkMentionTrigger = (): void => {
    const editorEl = this.deps.editorEl();
    // No Bot reads the file conversation, so there is no one to mention.
    if (!editorEl || this.deps.fileDrop()) {
      this.showMentionPopup = false;
      this.mentionDismissed = false;
      this.mentionQuery = "";
      this.mentionAnchorIndex = -1;
      return;
    }
    const textBefore = getTextBeforeCaret(editorEl);
    const trigger = detectMentionTrigger(textBefore, textBefore.length);
    if (!trigger.active) {
      this.showMentionPopup = false;
      this.mentionQuery = "";
      this.mentionAnchorIndex = -1;
      this.mentionHighlightIndex = 0;
      this.mentionDismissed = false;
      return;
    }

    if (
      this.mentionDismissed &&
      trigger.anchorIndex === this.mentionAnchorIndex &&
      trigger.query === this.mentionQuery
    ) {
      return;
    }

    const shouldResetHighlight =
      !this.showMentionPopup ||
      trigger.query !== this.mentionQuery ||
      trigger.anchorIndex !== this.mentionAnchorIndex;

    this.showMentionPopup = true;
    this.mentionQuery = trigger.query;
    this.mentionAnchorIndex = trigger.anchorIndex;
    this.mentionHighlightIndex = shouldResetHighlight ? 0 : this.mentionHighlightIndex;
    this.mentionDismissed = false;
  };

  selectMentionCandidate = (candidate: MentionCandidate): void => {
    const editorEl = this.deps.editorEl();
    if (!editorEl) return;
    insertMentionChipAtCaret(editorEl, candidate, this.deps.botsById());
    this.deps.syncDraftFromEditor();
    this.showMentionPopup = false;
    this.mentionDismissed = false;
    this.mentionQuery = "";
    this.mentionAnchorIndex = -1;
    editorEl.focus();
  };

  /** Only the mention popup closes on an outside click; Escape order is the shell's. */
  onWindowClick = (e: MouseEvent): void => {
    const target = e.target as Node | null;
    if (this.showMentionPopup && isOutside(target, this.deps.editorEl(), this.mentionPopupEl)) {
      this.showMentionPopup = false;
      this.mentionDismissed = false;
    }
  };
}
