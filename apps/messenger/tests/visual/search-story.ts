import type { SearchHit } from '@real-bot/protocol';
import type { MessengerApi } from '../../src/lib/messenger-api.ts';
import { reactive } from '../../src/lib/test-reactive.svelte.ts';
import { aBot, aDirect, aGroup, aMessage, aRoutine, fakeRuntime } from '../../src/lib/test-fixtures.ts';

/** Interactive search fixtures, isolated from the local daemon and personal workspace. */
export function searchStoryRuntime() {
	const bots = [aBot({ avatar: null, name: '周报助手', duties: '整理本周进展与待办' })];
	const group = aGroup({ name: '周报讨论组' });
	const direct = aDirect();
	const routine = aRoutine({ title: '周报汇总', instruction: '汇总本周进展', enabled: false });
	const messages = [aMessage({ id: 'report-message', body: '周报里的结论需要补充数据来源。', session_id: group.id }), aMessage({ id: 'delivery-message', kind: 'bot', author: bots[0].id, body: '周报草稿已完成。', session_id: direct.id })];
	const api = {
		getWorkspaceFileBlob: async () => new Blob(['# 周报\n\n本周完成全局搜索。\n'], { type: 'text/markdown' }),
		workspaceTree: async () => ({ entries: [] }),
		putWorkspaceFile: async () => ({ ok: true }),
	};
	const runtime = reactive(fakeRuntime({ bots, sessions: [group, direct], messages, routines: [routine], settings: { workspace_path: '/fixture', wizard_complete: true, locale: 'zh', theme: 'light' } as never }, { client: api as unknown as MessengerApi }));
	const hits: SearchHit[] = [
		{ kind: 'bot', id: bots[0].id, session_id: direct.id, session_title: bots[0].name, snippet: bots[0].duties },
		{ kind: 'session', id: group.id, session_title: group.name!, snippet: group.name! },
		{ kind: 'message', id: messages[0].id, session_id: group.id, session_title: group.name!, snippet: messages[0].body },
		{ kind: 'file', path: 'reports/周报.md', snippet: 'reports/周报.md' },
		{ kind: 'routine', id: routine.id, snippet: routine.title },
		{ kind: 'routine', id: 'deleted-routine', snippet: '已删除 Bot 的周报日程' },
	];
	let epoch = 0;
	let failed = false;
	runtime.closeSearch = () => { epoch++; runtime.searchQuery = ''; runtime.searchHits = []; runtime.searchLoading = false; runtime.searchError = false; };
	runtime.runSearch = async (query) => {
		const seq = ++epoch;
		runtime.searchQuery = query; runtime.searchHits = []; runtime.searchError = false;
		if (!query.trim()) { runtime.searchLoading = false; return; }
		runtime.searchLoading = true;
		await new Promise((resolve) => setTimeout(resolve, query === 'slow' ? 1200 : 120));
		if (seq !== epoch) return;
		runtime.searchLoading = false;
		if (query === 'error' && !failed) { failed = true; runtime.searchError = true; return; }
		runtime.searchHits = ['slow', 'error'].includes(query) ? hits : hits.filter((hit) => `${hit.snippet} ${hit.path ?? ''} ${hit.session_title ?? ''}`.includes(query.trim()));
	};
	runtime.selectSession = async (id, options) => {
		runtime.selectedId = id;
		runtime.sessionView(id).highlightedMessageId = options?.messageId ?? null;
		runtime.paneOpener?.({ kind: 'chat', sessionId: id });
	};
	runtime.openRoutine = async (botId, routineId) => {
		runtime.selectedId = direct.id;
		runtime.profileRoutineId = routineId;
		runtime.paneOpener?.({ kind: 'chat', sessionId: direct.id, side: { kind: 'settings', botId } });
		if (!runtime.paneOpener) { runtime.profileBotId = botId; runtime.sessionSettingsOpen = true; }
	};
	runtime.closeSessionSettings = () => { runtime.sessionSettingsOpen = false; runtime.profileBotId = null; };
	runtime.closeTerminal = () => { runtime.terminalOpen = false; };
	runtime.closeTrace = () => { runtime.traceTaskId = null; };
	runtime.openSettings = () => { runtime.settingsOpen = true; };
	runtime.openWorkspace = () => { if (runtime.paneOpener) runtime.paneOpener({ kind: 'workspace', selected: null }); else runtime.workspaceOpen = true; };
	return runtime;
}
