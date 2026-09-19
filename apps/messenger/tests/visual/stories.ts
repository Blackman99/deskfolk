/**
 * A pane mounted on its own with fixture data, so a screenshot means "this component looks like
 * this" and not "the database happened to contain that". No daemon, no WebSocket, no real rows.
 */
import { flushSync, type Component } from 'svelte';
import { STORY_SIZES, type StoryName } from './story-list.ts';
import { copyFor } from '../../src/lib/copy.ts';
import type { RouteLogRow } from '../../src/lib/overlays/route-log.ts';
import {
	aBot,
	aDirect,
	aGroup,
	aMessage,
	anApproval,
	anAttachment,
	anMcpServer,
	aProvider,
	aSkill,
	aTurn,
	fakeRuntime
} from '../../src/lib/test-fixtures.ts';
import { reactive } from '../../src/lib/test-reactive.svelte.ts';
import Shell from '../../src/lib/Shell.svelte';
import Onboarding from '../../src/lib/Onboarding.svelte';
import DangerDialog from '../../src/lib/overlays/DangerDialog.svelte';
import GroupPane from '../../src/lib/panels/GroupPane.svelte';
import ProfilePane from '../../src/lib/panels/ProfilePane.svelte';
import RouteLog from '../../src/lib/overlays/RouteLog.svelte';
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

/** Shaped like `RouteLogRow`, not like the daemon's row: the pane is handed labels, not codes. */
const routeRows: RouteLogRow[] = [
	{
		turnId: 'turn-1',
		botId: 'bot-1',
		botName: 'Researcher',
		botKnown: true,
		triggerMessageId: 'msg-1',
		model: 'grok-4.6',
		providerName: null,
		thinkingLabel: '高',
		signatureLabel: '推理',
		outcome: 'completed',
		outcomeLabel: '完成',
		failReason: null,
		feedback: [],
		reason: '这条要查证，挑了推理强的。',
		review: {
			faultLabel: '不怪模型',
			directionLabel: null,
			rounds: 1,
			reason: '一次就答对了。',
			blamedModel: false
		},
		createdAt: '2026-09-19T02:00:00.000Z',
		finishedAt: '2026-09-19T02:00:04.200Z',
		durationMs: 4200
	},
	{
		turnId: 'turn-2',
		botId: 'bot-2',
		botName: '选题策划',
		botKnown: true,
		triggerMessageId: 'msg-2',
		model: 'gemini-3.8-flash',
		providerName: 'Default',
		thinkingLabel: '不思考',
		signatureLabel: '闲聊',
		outcome: 'failed',
		outcomeLabel: '补全失败',
		failReason: '连不上端点',
		feedback: [
			{ message_id: 'msg-4', body: '这里不对，换个强一点的。', created_at: '2026-09-19T02:01:00.000Z' }
		],
		reason: '短问题，挑了快的。',
		review: {
			faultLabel: '模型不行',
			directionLabel: '换更强的',
			rounds: 3,
			reason: '同一件事来回三轮才对。',
			blamedModel: true
		},
		createdAt: '2026-09-19T02:00:06.000Z',
		finishedAt: '2026-09-19T02:00:06.900Z',
		durationMs: 900
	}
];

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
	patchImmediate: async () => true,
	openDeleteProviderConfirm: () => {},
	closeSettings: () => {},
	...over
});

/** The shared world's Bots all carry an image; this one adds the letter fallback to the shot. */
const pickerBots = [...bots, aBot({ id: 'bot-4', name: '配音', duties: '配音与混音', avatar: null })];

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
			themeMenuOpen: false,
			workspaceOpen: false,
			contextMenuSessionId: null,
			onOpenContextMenu: () => {},
			onToggleWorkspace: () => {},
			onOpenSettings: () => {},
			onCreateBot: () => {},
			onCreateGroup: () => {},
			onOpenArtifact: () => {},
			onPatchTheme: async () => true
		}
	},
	'sidebar-context': {
		component: Sidebar as never,
		props: {
			runtime: fakeRuntime(world, { selectedId: 'sess-1' }),
			t,
			selected: group,
			pinnedSessionIds: ['direct-1'],
			themeMenuOpen: false,
			workspaceOpen: false,
			contextMenuSessionId: 'sess-2',
			onOpenContextMenu: () => {},
			onToggleWorkspace: () => {},
			onOpenSettings: () => {},
			onCreateBot: () => {},
			onCreateGroup: () => {},
			onOpenArtifact: () => {},
			onPatchTheme: async () => true
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
	'route-log': {
		component: RouteLog as never,
		props: {
			rows: routeRows,
			sessionTitle: '视频全流程制作组',
			loading: false,
			showEndpoint: true,
			t,
			onClose: () => {},
			onJump: () => {}
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
				releaseUrl: 'https://github.com/Blackman99/real-bot/releases/tag/v0.1.0-rc.3',
				downloadUrl:
					'https://github.com/Blackman99/real-bot/releases/download/v0.1.0-rc.3/Real.Bot_0.1.0-rc.3_aarch64.dmg',
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
	}
};

export const stories = Object.fromEntries(
	Object.entries(defs).map(([name, def]) => [
		name,
		{ ...def, ...STORY_SIZES[name as StoryName] }
	])
) as Record<StoryName, Story & { width: number; height: number }>;
