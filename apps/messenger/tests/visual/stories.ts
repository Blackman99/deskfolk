/**
 * A pane mounted on its own with fixture data, so a screenshot means "this component looks like
 * this" and not "the database happened to contain that". No daemon, no WebSocket, no real rows.
 */
import type { Component } from 'svelte';
import { STORY_SIZES, type StoryName } from './story-list.ts';
import { copyFor } from '../../src/lib/copy.ts';
import { aBot, aDirect, aGroup, aSkill, fakeRuntime } from '../../src/lib/test-fixtures.ts';
import { reactive } from '../../src/lib/test-reactive.svelte.ts';
import DangerDialog from '../../src/lib/overlays/DangerDialog.svelte';
import GroupPane from '../../src/lib/panels/GroupPane.svelte';
import ProfilePane from '../../src/lib/panels/ProfilePane.svelte';
import RouteLog from '../../src/lib/overlays/RouteLog.svelte';
import CreateGroupSheet from '../../src/lib/sidebar/CreateGroupSheet.svelte';

const t = copyFor('zh');

export type Story = {
	component: Component<never, Record<string, never>, string>;
	props: Record<string, unknown>;
};

const bots = [
	aBot({ id: 'bot-1', name: 'Researcher', duties: '收集与整理资料' }),
	aBot({ id: 'bot-2', name: '选题策划', duties: '负责视频选题与内容方向' }),
	aBot({ id: 'bot-3', name: '分镜师', duties: '按剧本出分镜表' })
];

const routeRows = [
	{
		turnId: 'turn-1',
		botName: 'Researcher',
		botId: 'bot-1',
		avatar: null,
		model: 'grok-4.6',
		thinkingLevel: 'high',
		category: '推理',
		duration: '4.2s',
		outcome: '完成',
		failReason: null,
		reason: '这条要查证，挑了推理强的。',
		endpoint: null,
		triggerMessageId: 'msg-1',
		feedback: [],
		review: { fault: 'none', direction: 'same', rounds: 1, confidence: '高', reason: '一次就答对了。' }
	},
	{
		turnId: 'turn-2',
		botName: '选题策划',
		botId: 'bot-2',
		avatar: null,
		model: 'gemini-3.8-flash',
		thinkingLevel: 'none',
		category: '闲聊',
		duration: '0.9s',
		outcome: '补全失败',
		failReason: '连不上端点',
		reason: '短问题，挑了快的。',
		endpoint: 'Default',
		triggerMessageId: 'msg-2',
		feedback: [{ body: '这里不对' }],
		review: { fault: 'model', direction: 'stronger', rounds: 3, confidence: '高', reason: '模型太弱。' }
	}
];

const defs: Record<StoryName, Story> = {
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
	}
};

export const stories = Object.fromEntries(
	Object.entries(defs).map(([name, def]) => [
		name,
		{ ...def, ...STORY_SIZES[name as StoryName] }
	])
) as Record<StoryName, Story & { width: number; height: number }>;
