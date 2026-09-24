/**
 * A pane mounted on its own with fixture data, so a screenshot means "this component looks like
 * this" and not "the database happened to contain that". No daemon, no WebSocket, no real rows.
 */
import { flushSync, type Component } from 'svelte';
import { STORY_SIZES, type StoryName } from './story-list.ts';
import { copyFor } from '../../src/lib/copy.ts';
import {
	aBot,
	aBotDirect,
	aDirect,
	aGroup,
	aMessage,
	anApproval,
	anAttachment,
	anMcpServer,
	aProvider,
	aSkill,
	aRoutine,
	aTurn,
	fakeRuntime
} from '../../src/lib/test-fixtures.ts';
import { reactive } from '../../src/lib/test-reactive.svelte.ts';
import Shell from '../../src/lib/Shell.svelte';
import Onboarding from '../../src/lib/Onboarding.svelte';
import DangerDialog from '../../src/lib/overlays/DangerDialog.svelte';
import GroupPane from '../../src/lib/panels/GroupPane.svelte';
import ProfilePane from '../../src/lib/panels/ProfilePane.svelte';
import RoutineCard from '../../src/lib/panels/RoutineCard.svelte';
import CreateGroupSheet from '../../src/lib/sidebar/CreateGroupSheet.svelte';
import CreateBotSheet from '../../src/lib/sidebar/CreateBotSheet.svelte';
import SessionContextMenu from '../../src/lib/sidebar/SessionContextMenu.svelte';
import Sidebar from '../../src/lib/sidebar/Sidebar.svelte';
import ChatHeader from '../../src/lib/chat/ChatHeader.svelte';
import ChatStage from '../../src/lib/chat/ChatStage.svelte';
import SettingsModal from '../../src/lib/settings/SettingsModal.svelte';
import { updateChecker } from '../../src/lib/update-checker.svelte.ts';
import ArtifactPreview from '../../src/lib/overlays/ArtifactPreview.svelte';
import ArtifactCodeEditor from '../../src/lib/overlays/ArtifactCodeEditor.svelte';
import Workbench from '../../src/lib/workbench/Workbench.svelte';
import { makeBranch, makeLeaf } from '../../src/lib/workbench/layout-tree.ts';
import { paneMin } from '../../src/lib/workbench/pane-mins.ts';
import type { WorkbenchLayout, WorkbenchTab } from '../../src/lib/workbench/layout-types.ts';
import { createRawSnippet } from 'svelte';

const t = copyFor('zh');

export type Story = {
	component: Component<never, Record<string, never>, string>;
	props: Record<string, unknown>;
	/** Runs after mount, before the shot: for state a pane only exposes through its own UI. */
	afterMount?: (host: HTMLElement) => void;
};

/** One world every story draws from, so the panes agree with each other. */
const bots = [
	aBot({ id: 'bot-1', name: 'Researcher', duties: '收集与整理资料' }),
	aBot({ id: 'bot-2', name: '选题策划', duties: '负责视频选题与内容方向' }),
	aBot({ id: 'bot-3', name: '分镜师', duties: '按剧本出分镜表' })
];
const botsById = new Map(bots.map((b) => [b.id, b]));

const group = aGroup({ id: 'sess-1', name: '视频全流程制作组' });
const direct = aDirect({ id: 'direct-1' });
const sessions = [group, direct, aGroup({ id: 'sess-2', name: '周报组' })];

const messages = [
	aMessage({ id: 'msg-1', body: '帮我把这一集的选题定下来，参考上次那份大纲。' }),
	aMessage({
		id: 'msg-2',
		kind: 'bot',
		author: 'bot-1',
		turn_id: 'turn-done',
		body: '查了三个方向，**第二个**最稳：\n\n- 观众问得最多\n- 素材我们手上有\n- 竞品还没做过\n\n```ts\nconst pick = candidates[1];\n```',
		created_at: '2026-09-19T02:00:05.000Z',
		attachments: [anAttachment({ message_id: 'msg-2' })]
	}),
	aMessage({
		id: 'msg-3',
		kind: 'system',
		author: 'bot-2',
		turn_id: 'turn-1',
		body: '连不上端点，这一轮中断了。',
		created_at: '2026-09-19T02:00:08.000Z'
	})
];

const turns = [
	aTurn({ id: 'turn-done', status: 'completed', bot_id: 'bot-1' }),
	aTurn({ id: 'turn-1', status: 'running', bot_id: 'bot-2', trigger_message_id: 'msg-1' })
];

const providers = [
	aProvider(),
	aProvider({ id: 'prov-2', name: 'Anthropic', base_url: 'https://api.anthropic.com/v1' })
];

const mcpServers = [
	anMcpServer(),
	anMcpServer({
		id: 'mcp-2',
		name: 'image-gen',
		transport: 'http',
		command: '',
		args: [],
		url: 'https://mcp.example.com/sse',
		auth_set: true,
		enabled: false
	})
];

const settings = {
	workspace_path: '/Users/you/real-bot-workspace',
	endpoint_base_url: 'https://api.example.com/v1',
	endpoint_key_set: true,
	endpoint_models: ['grok-4.6'],
	endpoint_model_catalog: [],
	endpoint_default_model: 'grok-4.6',
	default_provider_id: 'prov-1',
	launch_at_login: true,
	locale: 'zh' as const,
	theme: 'system' as const,
	wizard_complete: true
};

const world = { bots, sessions, messages, turns, providers, mcpServers, settings, skills: [aSkill()] };

/**
 * Bot↔Bot directs opened from `msg-1`, kept out of `world` so every other baseline stays put.
 * Seven of them, so the sidebar has to cap the list and offer the rest.
 */
const botDirects = ['01', '02', '03', '04', '05', '06', '07'].map((n, i) =>
	aBotDirect({
		id: `botbot-${n}`,
		participants: [
			{ member: 'bot-1', joined_at: '2026-09-19T00:00:00.000Z', left_at: null },
			{ member: i % 2 === 0 ? 'bot-2' : 'bot-3', joined_at: '2026-09-19T00:00:00.000Z', left_at: null }
		],
		origin_session_id: 'sess-1',
		origin_message_id: 'msg-1',
		created_at: `2026-09-19T${n}:00:00.000Z`,
		last_message: aMessage({
			id: `botbot-msg-${n}`,
			session_id: `botbot-${n}`,
			kind: 'bot',
			author: 'bot-1',
			body: '这条线我去问问，问完回你。',
			created_at: `2026-09-19T${n}:30:00.000Z`
		})
	})
);
const botDmWorld = { ...world, sessions: [...sessions, ...botDirects] };

/**
 * The preview reads bytes through the local API. A tiny PNG keeps the shot off Monaco, which
 * loads asynchronously and would race the camera; the editor's own rules stay in the global sheet
 * for want of a baseline that can hold still.
 */
const PNG = Uint8Array.from(
	atob(
		'iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAYAAACqaXHeAAAAPElEQVR42u3OMQEAAAgDoC251a3g' +
			'LwSgcjeZXQIECBAgQIAAAQIECBAgQIAAAQIECBAgQIAAAQIECHwLHmHXAAFAsPm9AAAAAElFTkSuQmCC'
	),
	(c) => c.charCodeAt(0)
);

const previewApi = {
	getAttachmentBlob: async () => new Blob([PNG], { type: 'image/png' }),
	getWorkspaceFileBlob: async () => new Blob([PNG], { type: 'image/png' }),
	workspaceTree: async () => ({ entries: [] }),
	putWorkspaceFile: async () => ({ ok: true })
};

const previewAttachments = [
	anAttachment({ id: 'att-1', workspace_relpath: 'shots/cover.png', original_filename: 'cover.png', mime: 'image/png' }),
	anAttachment({ id: 'att-2', workspace_relpath: 'outline/ep-12.md', original_filename: 'ep-12.md', mime: 'text/markdown' }),
	anAttachment({ id: 'att-3', workspace_relpath: 'shots/board.mp4', original_filename: 'board.mp4', mime: 'video/mp4' })
];

/** The settings modal keeps the open tab to itself, so the story clicks it like a person would. */
const settingsTab = (index: number) => (host: HTMLElement) => {
	host.querySelectorAll<HTMLButtonElement>('.settings-tab-btn')[index]?.click();
};

const settingsProps = (over: Record<string, unknown> = {}) => ({
	runtime: fakeRuntime(world, { settingsOpen: true }),
	t,
	saveFailed: false,
	providerEditor: null,
	confirmingProvider: false,
	confirmingIndependent: false,
	patchImmediate: async () => true,
	openDeleteProviderConfirm: () => {},
	closeSettings: () => {},
	...over
});

/** The shared world's Bots all carry an image; this one adds the letter fallback to the shot. */
const pickerBots = [...bots, aBot({ id: 'bot-4', name: '配音', duties: '配音与混音', avatar: null })];


/**
 * A pane's content in the shots. The workbench never imports a content component itself — the
 * host passes one in — so the stories stand one in rather than pulling the real panes into the
 * layout module's graph.
 */
const storyTab = (id: string, kind: string, label: string): WorkbenchTab => ({
	id,
	kind,
	params: { label }
});

const storyBody = createRawSnippet((tab: () => WorkbenchTab) => ({
	render: () =>
		`<div style="padding:14px;color:var(--muted);font-size:13px">${tab().params.label ?? tab().kind}</div>`
}));
const storyLabel = createRawSnippet((tab: () => WorkbenchTab) => ({
	render: () => `<span>${tab().params.label ?? tab().kind}</span>`
}));

/**
 * The workbench paints its own gutters, so these shots show the dividers the same way the app
 * does. That is worth saying because it was once the other way round: the gutters were
 * transparent and read correctly here, sitting on `--bg`, while being invisible in the main
 * column, which paints itself `--pane`. A shot only tests what the component does not leave to
 * whatever is behind it.
 */
const storyEmptyActions = createRawSnippet(() => ({
	render: () =>
		`<div><button type="button" class="pane-open">${t.terminal.title}</button></div>`
}));

/** What the shell puts in the + menu, and what an empty pane now lays out as the same list. */
const storyMenuActions = createRawSnippet(() => {
	const term = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="4 17 10 11 4 5"></polyline><line x1="12" y1="19" x2="20" y2="19"></line></svg>`;
	const layers = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7.5 12 3l9 4.5-9 4.5L3 7.5Z"></path><path d="M3 12l9 4.5 9-4.5"></path><path d="M3 16.5 12 21l9-4.5"></path></svg>`;
	const calendar = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="5" width="18" height="16" rx="2"></rect><line x1="3" y1="10" x2="21" y2="10"></line><line x1="8" y1="3" x2="8" y2="7"></line><line x1="16" y1="3" x2="16" y2="7"></line></svg>`;
	const row = (name: string, mark: string, quiet: boolean, meta?: string) =>
		`<button type="button" class="wb-menu-row" role="menuitem"><span class="wb-menu-mark${quiet ? ' is-quiet' : ''}" aria-hidden="true">${mark}</span>` +
		(meta
			? `<span class="wb-menu-copy"><span class="wb-menu-name">${name}</span><span class="wb-menu-meta">${meta}</span></span>`
			: `<span class="wb-menu-name">${name}</span>`) +
		`</button>`;
	return {
		render: () =>
			`<div>${row(t.terminal.newTab, term, false)}${row(t.sidebar.workspace, layers, true)}${row(t.routines.title, calendar, true)}` +
			`<div class="wb-menu-section" role="presentation">${t.pane.runningTerminals}</div>` +
			`${row('real-bot-workspace', term, true, '/Users/me/real-bot-workspace')}${row('real-bot-workspace 2', term, true, '/Users/me/real-bot-workspace')}</div>`
	};
});

function workbenchProps(layout: WorkbenchLayout, wide = true) {
	return {
		layout,
		mins: paneMin,
		t,
		wide,
		tabBody: storyBody,
		tabLabel: storyLabel,
		// What the shell passes: it is what puts the new-tab button on the strip and what an
		// empty pane offers, so a shot without it is missing a piece the app always has.
		emptyActions: storyEmptyActions,
		onLayout: () => {}
	};
}

/** Two columns divided at the same height, which is what makes a genuine four-way cross. */
const crossLayout: WorkbenchLayout = {
	version: 1,
	root: makeBranch(
		'root',
		'row',
		[
			makeBranch(
				'left',
				'column',
				[
					makeLeaf('p1', [
						storyTab('wt1', 'chat', '视频全流程制作组'),
						// A conversation's settings and model-choice log are a sidebar in its own
						// tab, not tabs of their own, so the second tab here is another conversation.
						storyTab('wt6', 'chat', '剪辑师')
					]),
					makeLeaf('p2', [storyTab('wt3', 'terminal', 'real-bot')])
				],
				[0.55, 0.45]
			),
			makeBranch(
				'right',
				'column',
				[
					makeLeaf('p3', [storyTab('wt4', 'preview', 'storyboard.md')]),
					makeLeaf('p4', [storyTab('wt5', 'trace', '经过')])
				],
				// The same division as the left column, which is what puts a real four-way cross
				// in the shot rather than two separate T-junctions.
				[0.55, 0.45]
			)
		],
		[0.56, 0.44]
	),
	floating: [],
	focus: { zone: 'tiled', leafId: 'p1' }
};

const manyTabs: WorkbenchLayout = {
	version: 1,
	root: makeLeaf('p1', [
		storyTab('wt1', 'chat', '视频全流程制作组'),
		storyTab('wt2', 'trace', '经过'),
		storyTab('wt3', 'chat', '剪辑师'),
		storyTab('wt4', 'preview', 'storyboard.md'),
		storyTab('wt5', 'terminal', 'real-bot'),
		storyTab('wt6', 'workspace', '工作区')
	]),
	floating: [],
	focus: { zone: 'tiled', leafId: 'p1' }
};

/**
 * The group at a phone's width with its replies done, so ✨ is free to press: it answers at once
 * with more chips than one row holds, for the docked composer's spec to scroll through.
 */
const dockedRuntime: ReturnType<typeof fakeRuntime> = fakeRuntime(
	{ ...world, turns: turns.filter((turn) => turn.status !== 'running') },
	{
		selectedId: 'sess-1',
		suggestComposer: async (sessionId: string) => {
			dockedRuntime.sessionView(sessionId).composerSuggestions = [
				{ id: 's0', label: '让审片员复审第三场', prompt: '@审片员 请复审第三场的字幕与配音。' },
				{ id: 's1', label: '汇总今天的进度', prompt: '汇总一下今天每个人的进度。' },
				{ id: 's2', label: '细看分镜里的转场节奏', prompt: '细看分镜里的转场节奏，哪里拖了？' },
				{ id: 's3', label: '提炼三条剪辑要点', prompt: '把这轮讨论提炼成三条剪辑要点。' }
			];
		},
		dismissComposerSuggestions: (sessionId: string) => {
			dockedRuntime.sessionView(sessionId).composerSuggestions = [];
		}
	}
);

const defs: Record<StoryName, Story> = {
	shell: {
		component: Shell as never,
		props: {
			runtime: fakeRuntime(world, {
				selectedId: 'sess-1',
				approvals: [anApproval()]
			})
		}
	},
	'shell-narrow': {
		component: Shell as never,
		props: {
			runtime: fakeRuntime(world, { selectedId: 'sess-1', approvals: [anApproval()] })
		}
	},
	onboarding: {
		component: Onboarding as never,
		props: { runtime: fakeRuntime(world), onDismiss: () => {} }
	},
	sidebar: {
		component: Sidebar as never,
		props: {
			runtime: fakeRuntime(world, { selectedId: 'sess-1' }),
			t,
			selected: group,
			pinnedSessionIds: ['direct-1'],
			workspaceOpen: false,
			contextMenuSessionId: null,
			onOpenContextMenu: () => {},
			onToggleWorkspace: () => {},
			onOpenRoutines: () => {},
			onOpenSpend: () => {},
			onOpenSettings: () => {},
			onCreateBot: () => {},
			onCreateGroup: () => {},
			onOpenArtifact: () => {},
			onNewTerminal: () => {}
		}
	},
	'sidebar-context': {
		component: Sidebar as never,
		props: {
			runtime: fakeRuntime(world, { selectedId: 'sess-1' }),
			t,
			selected: group,
			pinnedSessionIds: ['direct-1'],
			workspaceOpen: false,
			contextMenuSessionId: 'sess-2',
			onOpenContextMenu: () => {},
			onToggleWorkspace: () => {},
			onOpenRoutines: () => {},
			onOpenSpend: () => {},
			onOpenSettings: () => {},
			onCreateBot: () => {},
			onCreateGroup: () => {},
			onOpenArtifact: () => {},
			onNewTerminal: () => {}
		}
	},
	'sidebar-botdm': {
		component: Sidebar as never,
		props: {
			runtime: fakeRuntime(botDmWorld, { selectedId: 'botbot-06' }),
			t,
			selected: botDirects[5],
			pinnedSessionIds: [],
			workspaceOpen: false,
			contextMenuSessionId: null,
			onOpenContextMenu: () => {},
			onToggleWorkspace: () => {},
			onOpenRoutines: () => {},
			onOpenSpend: () => {},
			onOpenSettings: () => {},
			onCreateBot: () => {},
			onCreateGroup: () => {},
			onOpenArtifact: () => {},
			onNewTerminal: () => {}
		}
	},
	'chat-header': {
		component: ChatHeader as never,
		props: {
			runtime: fakeRuntime(world, { selectedId: 'sess-1' }),
			t,
			selected: group,
			pinnedSessionIds: ['direct-1'],
			onTogglePin: () => {},
			onToggleSessionSettings: () => {},
			onCreateBot: () => {},
			onShowOnboarding: () => {}
		}
	},
	'chat-stage': {
		component: ChatStage as never,
		props: {
			runtime: fakeRuntime(world, { selectedId: 'sess-1', approvals: [anApproval()] }),
			t,
			selected: group,
			onOpenProfile: () => {},
			onOpenArtifact: () => {},
			onCreateBot: () => {}
		}
	},
	'chat-stage-botdm': {
		component: ChatStage as never,
		props: {
			runtime: fakeRuntime(botDmWorld, { selectedId: 'sess-1' }),
			t,
			selected: group,
			onOpenProfile: () => {},
			onOpenArtifact: () => {},
			onCreateBot: () => {}
		}
	},
	'chat-stage-narrow': {
		component: ChatStage as never,
		props: {
			runtime: dockedRuntime,
			t,
			selected: group,
			onOpenProfile: () => {},
			onOpenArtifact: () => {},
			onCreateBot: () => {}
		},
		// The shell names the column a `conversation` container; on its own the stage has none.
		afterMount: (host) => {
			host.style.display = 'flex';
			host.style.flexDirection = 'column';
			host.style.container = 'conversation / inline-size';
		}
	},
	'context-menu': {
		component: SessionContextMenu as never,
		props: {
			session: group,
			botsById,
			isPinned: false,
			x: 16,
			y: 16,
			t,
			onClose: () => {},
			onTogglePin: () => {},
			onViewInfo: () => {},
			onClearHistory: () => {},
			onToggleArchive: () => {},
			onDelete: () => {}
		}
	},
	'danger-dialog-narrow': {
		component: DangerDialog as never,
		props: {
			copy: { title: 'Delete routine', body: 'Deleting this routine does not stop work already started.', confirm: 'Confirm delete', cancel: 'Cancel' },
			t: copyFor('en'), onDismiss: () => {}, onConfirm: () => {}
		}
	},
	'danger-dialog': {
		component: DangerDialog as never,
		props: {
			copy: {
				title: '删除群聊',
				body: '删除后，这个群和里面的消息、轮次都去掉。名册上的 Bot 还在。',
				confirm: '确认删除',
				cancel: '取消'
			},
			t,
			onDismiss: () => {},
			onConfirm: () => {}
		}
	},
	'create-group-sheet': {
		component: CreateGroupSheet as never,
		props: { runtime: fakeRuntime({ bots }), bots, t, onClose: () => {} }
	},
	/*
	 * The member list is a floating layer the closed sheet never shows, so this story opens it the
	 * way a person does and picks one Bot — the only shot that covers a row's avatar, the chip it
	 * becomes, and the letter a Bot without an image falls back to.
	 */
	'create-group-picker': {
		component: CreateGroupSheet as never,
		props: { runtime: fakeRuntime({ bots: pickerBots }), bots: pickerBots, t, onClose: () => {} },
		afterMount: (host) => {
			host
				.querySelector('.multi-select-field')
				?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
			flushSync();
			host.querySelectorAll<HTMLElement>('.multi-select-option')[1]?.click();
			flushSync();
		}
	},
	'create-bot-sheet': {
		component: CreateBotSheet as never,
		props: {
			runtime: fakeRuntime(world),
			modelOptions: [
				{ value: '', label: '自动' },
				{ value: 'grok-4.6', label: 'grok-4.6' }
			],
			t,
			onClose: () => {}
		}
	},
	'group-pane': {
		component: GroupPane as never,
		props: {
			runtime: fakeRuntime({ bots, sessions: [aGroup()] }),
			selected: aGroup(),
			t,
			detail: reactive({
				sessionId: 'sess-1',
				name: '视频全流程制作组',
				nameError: undefined,
				failed: false,
				pullPick: ''
			}),
			onOpenProfile: () => {},
			onDeleteGroup: () => {},
			onClearHistory: () => {}
		}
	},
	'group-pane-section': {
		component: GroupPane as never,
		props: {
			runtime: fakeRuntime({ bots, sessions: [aGroup()] }),
			selected: aGroup(),
			t,
			mobileDetail: true,
			detail: reactive({
				sessionId: 'sess-1',
				name: '视频全流程制作组',
				nameError: undefined,
				failed: false,
				pullPick: ''
			}),
			onOpenProfile: () => {},
			onDeleteGroup: () => {},
			onClearHistory: () => {}
		}
	},
	'routine-card': {
		component: RoutineCard as never,
		props: { runtime: fakeRuntime({ routines: [aRoutine(), aRoutine({ id: 'weekly', title: 'Weekly review', enabled: false, schedule: { kind: 'weekly', time: '17:30', weekdays: ['mon', 'fri'] } })] }), bot: bots[0], t }
	},
	'routine-editor-narrow': {
		component: RoutineCard as never,
		props: { runtime: fakeRuntime({ routines: [aRoutine({ schedule: { kind: 'weekly', time: '17:30', weekdays: ['mon', 'fri'] } })] }), bot: bots[0], t },
		afterMount(host) { (host.querySelector('.routine-open') as HTMLButtonElement).click(); flushSync(); }
	},
	'routine-empty': {
		component: RoutineCard as never,
		props: { runtime: fakeRuntime(), bot: bots[0], t }
	},
	'profile-pane': {
		component: ProfilePane as never,
		props: {
			runtime: (() => {
				const rt = fakeRuntime({ bots, skills: [aSkill()], sessions: [aDirect()] });
				rt.profileBotId = 'bot-1';
				return rt;
			})(),
			bot: bots[0]!,
			t,
			modelOptions: [],
			selectedKind: 'you-bot',
			profileFailed: false,
			openDangerConfirm: () => {},
			clearDanger: () => {},
			onDeleteBot: () => {},
			onClearHistory: () => {}
		}
	},
	'profile-pane-section': {
		component: ProfilePane as never,
		props: {
			runtime: (() => {
				const rt = fakeRuntime({ bots, skills: [aSkill()], sessions: [aDirect()] });
				rt.profileBotId = 'bot-1';
				return rt;
			})(),
			bot: bots[0]!,
			t,
			modelOptions: [],
			selectedKind: 'you-bot',
			profileFailed: false,
			mobileDetail: true,
			openDangerConfirm: () => {},
			clearDanger: () => {},
			onDeleteBot: () => {},
			onClearHistory: () => {}
		}
	},
	'artifact-preview': {
		component: ArtifactPreview as never,
		props: {
			attachment: previewAttachments[0]!,
			relpath: 'shots/cover.png',
			siblings: previewAttachments,
			api: previewApi,
			workspacePath: '/Users/you/real-bot-workspace',
			t,
			onClose: () => {},
			onSelect: () => {},
			mode: 'cited'
		}
	},
	'artifact-code': {
		component: ArtifactCodeEditor as never,
		props: {
			code: 'export function pick(list: string[]): string {\n\t// the second one was the safe bet\n\treturn list[1] ?? list[0]!;\n}\n',
			path: 'src/pick.ts',
			wrap: false
		}
	},
	'settings-general': { component: SettingsModal as never, props: settingsProps(), afterMount: settingsTab(0) },
	'settings-providers': { component: SettingsModal as never, props: settingsProps(), afterMount: settingsTab(2) },
	'settings-mcp': { component: SettingsModal as never, props: settingsProps(), afterMount: settingsTab(3) },
	/*
	 * The About card with an update waiting. The card only draws inside a Tauri window, so the
	 * story says the window is one and hands the checker a finished check — including the release
	 * body, which is where the list of what changed comes from.
	 */
	'settings-about': {
		component: SettingsModal as never,
		props: settingsProps(),
		afterMount: (host: HTMLElement) => {
			settingsTab(4)(host);
			(globalThis as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {
				invoke: async () => null
			};
			updateChecker.version = '0.1.0-rc.2';
			updateChecker.status = 'ok';
			updateChecker.result = {
				current: '0.1.0-rc.2',
				latest: '0.1.0-rc.3',
				updateAvailable: true,
				releaseUrl: 'https://github.com/Blackman99/deskfolk/releases/tag/v0.1.0-rc.3',
				downloadUrl:
					'https://github.com/Blackman99/deskfolk/releases/download/v0.1.0-rc.3/Deskfolk_0.1.0-rc.3_aarch64.dmg',
				publishedAt: '2026-09-19T00:00:00Z',
				notes: [
					'未签名的 macOS rc。优先从源码运行。',
					'',
					'### Messenger',
					'',
					'- 新建群改成和新建 Bot 一样的居中弹窗，成员用可搜索的多选下拉挑。',
					'- 检查更新时把这一版改了什么直接列在「关于」里，不用再跳浏览器。',
					'',
					'### Daemon',
					'',
					'- 本机接口同时听 `127.0.0.1:17890` 和 `[::1]:17890`。'
				].join('\n')
			};
			flushSync();
		}
	},
	workbench: {
		component: Workbench as never,
		props: workbenchProps(crossLayout)
	},
	'workbench-tabs': {
		component: Workbench as never,
		props: workbenchProps(manyTabs)
	},
	'workbench-empty': {
		component: Workbench as never,
		props: {
			...workbenchProps({
				version: 1,
				root: makeLeaf('p1', []),
				floating: [],
				focus: { zone: 'tiled', leafId: 'p1' }
			}),
			menuActions: storyMenuActions
		}
	},
	'workbench-solo': {
		component: Workbench as never,
		props: workbenchProps(crossLayout, false)
	},
	'workbench-float': {
		component: Workbench as never,
		props: workbenchProps({
			version: 1,
			root: makeBranch(
				'root',
				'row',
				[
					makeLeaf('p1', [storyTab('ft1', 'chat', '视频全流程制作组')]),
					makeLeaf('p2', [storyTab('ft2', 'workspace', '工作区')])
				],
				[0.6, 0.4]
			),
			floating: [
				{
					leaf: makeLeaf('f1', [storyTab('ft3', 'terminal', 'real-bot')]),
					frame: { x: 90, y: 110, width: 420, height: 300 }
				},
				{
					leaf: makeLeaf('f2', [storyTab('ft4', 'trace', '经过')]),
					frame: { x: 320, y: 260, width: 440, height: 320 }
				}
			],
			focus: { zone: 'floating', leafId: 'f2' }
		})
	}
};

const maintenanceRuntime = (over: Record<string, unknown> = {}) =>
	fakeRuntime(world, {
		settingsOpen: true,
		remote: true,
		uvReady: true,
		maintenance: {
			version: '0.1.0-rc.2',
			mode: 'window',
			reachability: 'online',
			restart: 'available',
			stopped: false,
			drain: { phase: 'draining', remaining: 2, forced: false },
			devices: [
				{ id: '01ARZ3NDEKTSV4RRFFQ69G5FAV', name: 'This Mac', revoked: false, hasUv: true },
				{ id: '01ARZ3NDEKTSV4RRFFQ69G5FAW', name: 'Travel phone', revoked: false, hasUv: true }
			]
		},
		otherRemoteDevices: () => [
			{ id: '01ARZ3NDEKTSV4RRFFQ69G5FAW', name: 'Travel phone', revoked: false, hasUv: true }
		],
		...over
	});

export const rc11Stories = {
	'sidebar-tools': {
		...defs.sidebar,
		props: {
			...defs.sidebar.props,
			t: copyFor('en'),
			runtime: fakeRuntime({ ...world, settings: { ...world.settings, locale: 'en' } })
		},
		width: 300,
		height: 820
	},
	'settings-maintenance': {
		component: SettingsModal as never,
		props: settingsProps({ runtime: maintenanceRuntime() }),
		afterMount: settingsTab(0),
		width: 1440,
		height: 1000
	},
	'settings-maintenance-force': {
		component: SettingsModal as never,
		props: settingsProps({ runtime: maintenanceRuntime({ maintenanceForceConfirm: true, maintenanceStopConfirm: true, maintenanceRevokeId: '01ARZ3NDEKTSV4RRFFQ69G5FAW' }) }),
		afterMount: settingsTab(0),
		width: 1440,
		height: 1000
	},
	'settings-maintenance-error': {
		component: SettingsModal as never,
		props: settingsProps({
			runtime: fakeRuntime(world, {
				settingsOpen: true,
				remote: true,
				uvReady: true,
				maintenanceError: 'request_unknown',
				maintenance: {
					version: '0.1.0-rc.2',
					mode: 'none',
					reachability: 'disconnected',
					restart: 'unavailable',
					stopped: false,
					drain: { phase: 'running', remaining: 0, forced: false },
					devices: []
				},
				otherRemoteDevices: () => []
			})
		}),
		afterMount: settingsTab(0),
		width: 430,
		height: 932
	}
};

export const stories = Object.fromEntries(
	Object.entries(defs).map(([name, def]) => [
		name,
		{ ...def, ...STORY_SIZES[name as StoryName] }
	])
) as Record<StoryName, Story & { width: number; height: number }>;
