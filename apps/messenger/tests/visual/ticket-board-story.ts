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
    spec: { kind: '分镜', goal: '先出分镜', acceptance: ['交到 board.pdf'], rules: [], process: [], progress: { done: [], open: [], blocked: [] }, status: 'active' },
    spec_updated_at: '2026-09-22T00:00:00.000Z', revision: 2, revision_actor: 'app', routine_id: null, tickets,
  } as unknown as TaskDetail;
  const trace: TaskTrace = {
    id: 'task-1', dir: 'work/fixture', title: '先出分镜', session_id: 'group-1', closed_at: null,
    nodes: [{
      turn_id: 'user:m1', session_id: 'group-1', actor: USER_MEMBER, status: 'completed', woken_by_turn_id: null,
      woken_elsewhere: null, ticket_id: null, trigger_message_id: 'm1', focus_message_id: 'm1', summary: '先出分镜',
      created_at: '2026-09-22T00:00:00.000Z', artifacts: [], ask: null, approval: null, passed: 0,
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
