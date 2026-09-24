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
	'routine-card': { width: 520, height: 800 },
	'routine-editor-narrow': { width: 390, height: 1100 },
	'routine-empty': { width: 390, height: 440 },
	onboarding: { width: 900, height: 720 },
	sidebar: { width: 300, height: 820 },
	// The row under an open context menu: a rule that used to live in the last file imported,
	// so its cascade position was doing work that scoping has to reproduce.
	'sidebar-context': { width: 300, height: 820 },
	// Bot↔Bot directs: capped list with a source line under each row, and the entry point the
	// transcript hangs under the message that set them off. Neither appears in any other shot.
	'sidebar-botdm': { width: 300, height: 820 },
	'chat-header': { width: 900, height: 120 },
	'chat-stage': { width: 900, height: 820 },
	'chat-stage-botdm': { width: 900, height: 820 },
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
	'settings-providers': { width: 1000, height: 720 },
	'settings-mcp': { width: 1000, height: 720 },
	'settings-about': { width: 1000, height: 720 },
	// A four-pane arrangement with a real four-way cross in it: the junction handle, the tab
	// strips and the focused-pane marking are all only visible here.
	workbench: { width: 1280, height: 820 },
	// A strip with more tabs than fit: the overflow scrolls and the pane menu holds its place.
	'workbench-tabs': { width: 520, height: 320 },
	'workbench-empty': { width: 520, height: 480 },
	// Below the breakpoint the tree is kept but only the focused pane is drawn.
	'workbench-solo': { width: 600, height: 820 },
	// Two panes lifted out of the tree, overlapping, so the z-order and the shadow are visible.
	'workbench-float': { width: 1000, height: 700 }
} as const;

export type StoryName = keyof typeof STORY_SIZES;
