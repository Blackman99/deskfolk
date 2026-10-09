/**
 * The flow pane with a plan of five tickets, one of each status, so the board's columns can be
 * seen across — on a wide window behind the Board button, and on a narrow one behind the Tickets
 * tab. The trace and the plan are fixtures; nothing is fetched.
 */
import type { TaskDetail, TaskTrace, TicketWithArtifacts } from '@real-bot/protocol';
import { USER_MEMBER } from '@real-bot/protocol';
import { aBot, aGroup } from '../../src/lib/test-fixtures.ts';
import { copyFor } from '../../src/lib/copy.ts';
import TraceView from '../../src/lib/overlays/TraceView.svelte';

function ticket(over: Partial<TicketWithArtifacts>): TicketWithArtifacts {
  return {
    id: 'tk', task_id: 'task-1', seq: 1, title: '任务', slug: '01', dir: 'work/fixture/01', spec: '', status: 'todo',
    worker: null, created_at: '2026-09-22T00:00:00.000Z', updated_at: '2026-09-22T00:00:00.000Z', closed_at: null, artifacts: [], ...over,
  };
}

const STATUSES = ['todo', 'doing', 'review', 'done', 'parked'] as const;

function storyCheck(over: { id: string; item: string; path: string; outcome: 'pass' | 'fail' }): unknown {
  const at = '2026-09-22T00:00:00.000Z';
  return {
    id: over.id, task_id: 'task-1', ticket_id: null, item: over.item, kind: 'exists', path: over.path, pattern: null, negate: false,
    command: null, cwd: null, expect_exit: null, expect_stdout: null, timeout_sec: null, source: 'user', created_at: at, updated_at: at,
    defined_at: at, first_passed_at: over.outcome === 'pass' ? at : null, running: false,
    last_run: { id: `run-${over.id}`, check_id: over.id, task_id: 'task-1', cause: 'settle', started_at: at, finished_at: at, outcome: over.outcome,
      exit_code: over.outcome === 'pass' ? 0 : 1, detail: over.outcome === 'pass' ? 'ok' : '没找到', output: null },
  };
}

function storyRequirement(over: Record<string, unknown>): unknown {
  return {
    id: 'req', seq: 1, quote: '', restated: null, category: null, polarity: 'must', dimension: null, value: null, status: 'open',
    scope: 'plan', ticket_id: null, domain: null, times_raised: 1, plans_raised: 1, last_raised_at: '2026-09-22T00:00:00.000Z',
    source_kind: 'message', source: null, added_by: 'scribe', inherited_from: null, excluded: false, supersedes: null, ...over,
  };
}

export function ticketBoardStory() {
  const t = copyFor('zh');
  const tickets = [
    ...STATUSES.map((status, index) => ticket({ id: `tk-${index + 1}`, seq: index + 1, title: `任务 ${index + 1}`, status, worker: index === 1 ? 'bot-2' : null })),
    // One column has to be taller than the pane, or "each column scrolls" cannot be seen.
    ...Array.from({ length: 10 }, (_, index) => ticket({ id: `more-${index}`, seq: 6 + index, title: `补充 ${index + 1}`, status: 'todo' })),
  ];
  const detail = {
    id: 'task-1', dir: 'work/fixture', title: '先出分镜', session_id: 'group-1', closed_at: null,
    last_activity_at: '2026-09-22T00:00:00.000Z', goal: '先出分镜', kind: '分镜', status: 'active',
    ticket_counts: { todo: 11, doing: 1, review: 1, done: 1, parked: 1 }, brief: '先出分镜',
    // A spec with something in every part, so the spec view is read the way a real job fills it.
    spec: {
      kind: '分镜', goal: '用 2018 年 IG 夺冠的高光镜头做一支 3 分钟的 MV，节奏跟着配乐走，结尾落在捧杯', status: 'active',
      acceptance: ['成片 3 分钟以内、1080p，交到 final.mp4', '每一段开头有比赛年份和对手的字幕', '配乐全程没有版权问题'],
      rules: ['不要真人出镜，全部用 3D 重演', '画风统一为 Blender 卡通渲染', '字幕用思源黑体，白字黑边'],
      process: ['先出分镜样片给你确认', '逐段 3D 重做，每段交一次', '最后统一调色和混音'],
      progress: { done: ['分镜样片已确认', '第一段开场已通过'], open: ['第二段八强逆转在做', '第三段半决赛待开工'], blocked: ['决赛缺少高清素材源'] },
    },
    checks: [
      storyCheck({ id: 'c1', item: '成片 3 分钟以内、1080p，交到 final.mp4', path: 'work/fixture/final.mp4', outcome: 'pass' }),
      storyCheck({ id: 'c2', item: '每一段开头有比赛年份和对手的字幕', path: 'work/fixture/subtitles.srt', outcome: 'fail' }),
    ],
    requirements: [
      storyRequirement({ id: 'req-1', seq: 1, quote: '不要真人出镜', category: 'content', polarity: 'must_not', times_raised: 2 }),
      storyRequirement({ id: 'req-2', seq: 2, quote: '结尾要落在捧杯那一刻', category: 'content' }),
      storyRequirement({ id: 'req-3', seq: 3, quote: '第二段节奏再快一点', scope: 'ticket', ticket_id: 'tk-2', category: 'pacing' }),
    ],
    scale: { value: 'large', unit: '段', by: 'reader', at: '2026-09-22T00:00:00.000Z', why: '分五段做' },
    revision_cause: null, last_change: { at: '2026-09-22T00:00:00.000Z', what: '要点' },
    spec_updated_at: '2026-09-22T00:00:00.000Z', revision: 2, revision_actor: 'app', routine_id: null, tickets,
  } as unknown as TaskDetail;
  const trace: TaskTrace = {
    id: 'task-1', dir: 'work/fixture', title: '先出分镜', session_id: 'group-1', closed_at: null,
    nodes: [{
      turn_id: 'user:m1', session_id: 'group-1', actor: USER_MEMBER, status: 'completed', woken_by_turn_id: null,
      woken_elsewhere: null, ticket_id: null, trigger_message_id: 'm1', focus_message_id: 'm1', summary: '先出分镜',
      created_at: '2026-09-22T00:00:00.000Z', artifacts: [], ask: null, approval: null, passed: 0,
    }, {
      // A turn worked in ticket 02, so a card picked on the board has rounds to show on the trace.
      turn_id: 't-2', session_id: 'group-1', actor: 'bot-2', status: 'completed', woken_by_turn_id: 'user:m1',
      woken_elsewhere: null, ticket_id: 'tk-2', trigger_message_id: 'm1', focus_message_id: 'm2', summary: '第二段的分镜画好了',
      created_at: '2026-09-22T00:05:00.000Z', artifacts: [], ask: null, approval: null, passed: 0,
    }],
  };
  const api = {
    sessionTasks: async () => [detail],
    taskTrace: async () => trace,
    taskDetail: async () => detail,
    taskSpecRevisions: async () => [],
    // Every move is written down for the spec to read, and the ticket comes back where it went.
    patchTicket: async (id: string, body: { status?: TicketWithArtifacts['status'] }) => {
      document.body.dataset.ticketPatches = JSON.stringify([...JSON.parse(document.body.dataset.ticketPatches ?? '[]'), { id, body }]);
      const row = tickets.find((entry) => entry.id === id)!;
      return { ...row, ...(body.status ? { status: body.status } : {}) };
    },
  };
  return {
    component: TraceView as never,
    props: {
      api, taskId: 'task-1', sessionId: 'group-1', activeSessionId: 'group-1', sessions: [aGroup({ id: 'group-1', name: '制作组' })],
      bots: [aBot({ id: 'bot-1', name: '制片' }), aBot({ id: 'bot-2', name: '分镜师' })], youLabel: '你', deletedLabel: '已删除',
      workspacePath: '/work', t, reloadToken: 0, host: 'pane', onJump: () => {}, onTask: () => {},
    },
    width: 1280, height: 800,
    afterMount(host: HTMLElement) {
      document.body.style.width = '100vw';
      document.body.style.height = '100dvh';
      host.style.width = '100vw';
      host.style.height = '100dvh';
    },
  };
}
