/** Names and the size each pane is shot at. Plain data, so the Playwright side can read it too. */
export const STORY_SIZES = {
	shell: { width: 1280, height: 820 },
	// The 680px breakpoint is the one rule set no single pane owns; without a narrow shot the
	// whole `responsive.css` file is untested.
	'shell-narrow': { width: 600, height: 820 },
	'danger-dialog': { width: 900, height: 520 },
	'danger-dialog-narrow': { width: 390, height: 844 },
	// A modal, not a flyout any more: shot at a window it fits in, with room under the field for
	// the member list to open into.
	'create-group-sheet': { width: 560, height: 560 },
	// The same sheet with its member list open: a floating layer no other shot reaches.
	'create-group-picker': { width: 560, height: 620 },
	'create-bot-sheet': { width: 340, height: 720 },
	'group-pane': { width: 420, height: 900 },
	'group-pane-section': { width: 420, height: 900 },
	'profile-pane': { width: 420, height: 1100 },
	'profile-pane-section': { width: 420, height: 1100 },
	// Past the 680px breakpoint, so the list and its inline editor get the drawer layout; the
	// story holds the list itself to 520, the width the seven day buttons are checked at.
	'routine-card': { width: 700, height: 420 },
	'routine-editor': { width: 700, height: 1000 },
	'routine-editor-narrow': { width: 390, height: 1100 },
	'routine-empty': { width: 390, height: 440 },
	onboarding: { width: 900, height: 720 },
	sidebar: { width: 300, height: 820 },
	// The row under an open context menu: a rule that used to live in the last file imported,
	// so its cascade position was doing work that scoping has to reproduce.
	'sidebar-context': { width: 300, height: 820 },
	// No conversation yet: the list's empty state with its two ways to start one.
	'sidebar-empty': { width: 300, height: 820 },
	// Bot↔Bot directs: capped list with a source line under each row, and the entry point the
	// transcript hangs under the message that set them off. Neither appears in any other shot.
	'sidebar-botdm': { width: 300, height: 820 },
	// The list folded to its rail, with the footer's tools menu flown out beside it: the only shot
	// of the rail's icon footer and of a menu placed to the side of its button.
	'sidebar-rail': { width: 300, height: 820 },
	'search-dialog': { width: 1280, height: 820 },
	'search-dialog-narrow': { width: 390, height: 844 },
	'chat-header': { width: 900, height: 120 },
	'chat-stage': { width: 900, height: 820 },
	'chat-stage-botdm': { width: 900, height: 820 },
	// One Bot reply in three parts, stacked under one header with no labels or rules between them.
	'chat-stage-segments': { width: 900, height: 820 },
	// A conversation as narrow as a phone docks its composer across the bottom instead of floating it.
	'chat-stage-narrow': { width: 390, height: 844 },
	'context-menu': { width: 340, height: 420 },
	'artifact-preview': { width: 900, height: 640 },
	'artifact-code': { width: 700, height: 420 },
	// Annotations: the preview with its list column, a draft waiting in the send bar, and marks drawn
	// on the image; the narrow shot stacks the list under the file.
	'artifact-annotations': { width: 1000, height: 640 },
	'artifact-annotations-narrow': { width: 390, height: 844 },
	// A batch in the transcript: the quoted delivery, the summary, and one card per annotation.
	'chat-stage-annotations': { width: 900, height: 820 },
	'settings-general': { width: 1000, height: 720 },
	'settings-open-placement': { width: 1000, height: 820 },
	'settings-providers': { width: 1000, height: 720 },
	'settings-models-ladder': { width: 1000, height: 720 },
	'settings-models-ladder-claude': { width: 1000, height: 720 },
	'settings-models-ladder-claude-narrow': { width: 390, height: 844 },
	'settings-models-speech': { width: 1000, height: 720 },
	'settings-models-narrow': { width: 390, height: 844 },
	// The two-level model picker (endpoints, Claude, every local agent): sources and models, a search, the phone's sheet.
	'model-picker-sources': { width: 760, height: 560 },
	'model-picker-search': { width: 760, height: 560 },
	'model-picker-sheet': { width: 390, height: 844 },
	'model-picker-sheet-group': { width: 390, height: 844 },
	'model-picker-narrow': { width: 760, height: 560 },
	'speech-service-picker-open': { width: 380, height: 336 },
	'settings-agents': { width: 1000, height: 720 },
	'settings-agents-open': { width: 1000, height: 720 },
	'settings-agents-narrow': { width: 390, height: 844 },
	'settings-mcp': { width: 1000, height: 720 },
	'settings-prompts': { width: 1000, height: 720 },
	'settings-prompts-narrow': { width: 390, height: 844 },
	'settings-about': { width: 1000, height: 720 },
	// The remote access tab before the Mac has a relay, with the deploy-your-own guide unfolded.
	'settings-remote-guide': { width: 1000, height: 900 },
	// A four-pane arrangement with a real four-way cross in it: the junction handle, the tab
	// strips and the focused-pane marking are all only visible here.
	workbench: { width: 1280, height: 820 },
	// A strip with more tabs than fit: the overflow scrolls and the pane menu holds its place.
	'workbench-tabs': { width: 520, height: 320 },
	'workbench-empty': { width: 520, height: 480 },
	// Below the breakpoint the tree is kept but only the focused pane is drawn.
	'workbench-solo': { width: 600, height: 820 },
	// Two panes lifted out of the tree, overlapping, so the z-order and the shadow are visible.
	'workbench-float': { width: 1000, height: 700 },
	// The usage ball opened into its column of agents, Claude's card grown out of its bubble
	// (ADR 0080): two Claude accounts, one nearly spent.
	'usage-widget': { width: 900, height: 640 },
	// The phone's usage page from Tools: the usage tab's board in one column.
	'usage-page': { width: 390, height: 844 },
	// The workbench's usage tab: a card per account across the width, each window a bar.
	'usage-tab': { width: 1280, height: 720 }
} as const;

export type StoryName = keyof typeof STORY_SIZES;
