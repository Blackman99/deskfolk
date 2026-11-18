import type { MentionableBot } from "./chat/mention-chips.ts";

/** What a bubble's markdown is read with: links to the workspace, the roster's mentions. */
export type RenderMarkdownOptions = {
  streaming?: boolean;
  extraPaths?: string[];
  mentionBots?: readonly MentionableBot[];
  /** Present members eligible for lenient prefix/suffix resolution of misspelt @tokens. */
  mentionMembers?: readonly MentionableBot[];
  /** Title attribute for an unresolved @token marker. */
  unresolvedMentionTitle?: string;
  /**
   * Mark every block with the source lines it came from (`data-src-start` / `data-src-end`), for the
   * artifact preview's annotations to map a selection back to lines. Leading YAML front matter shows
   * as a yaml block. Chat bubbles leave it off and render exactly as before.
   */
  sourceLines?: boolean;
};
