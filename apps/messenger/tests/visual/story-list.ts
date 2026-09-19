/** Names and the size each pane is shot at. Plain data, so the Playwright side can read it too. */
export const STORY_SIZES = {
	'danger-dialog': { width: 900, height: 520 },
	'route-log': { width: 900, height: 640 },
	'create-group-sheet': { width: 340, height: 520 },
	'group-pane': { width: 420, height: 900 },
	'profile-pane': { width: 420, height: 900 }
} as const;

export type StoryName = keyof typeof STORY_SIZES;
