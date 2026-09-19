/** Names and the size each pane is shot at. Plain data, so the Playwright side can read it too. */
export const STORY_SIZES = {
	shell: { width: 1280, height: 820 },
	'danger-dialog': { width: 900, height: 520 },
	'route-log': { width: 900, height: 640 },
	'create-group-sheet': { width: 340, height: 520 },
	'create-bot-sheet': { width: 340, height: 720 },
	'group-pane': { width: 420, height: 900 },
	'profile-pane': { width: 420, height: 900 },
	onboarding: { width: 900, height: 720 },
	sidebar: { width: 300, height: 820 },
	'chat-header': { width: 900, height: 120 },
	'chat-stage': { width: 900, height: 820 },
	'context-menu': { width: 340, height: 420 },
	'settings-general': { width: 1000, height: 720 },
	'settings-providers': { width: 1000, height: 720 },
	'settings-mcp': { width: 1000, height: 720 }
} as const;

export type StoryName = keyof typeof STORY_SIZES;
