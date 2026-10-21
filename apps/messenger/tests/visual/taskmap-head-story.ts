/**
 * A Bot conversation's task map over a plan with a long title, so where the head's title breaks and
 * what the switcher's list opens over can be measured. Every call is a fixture; the map is the real one.
 */
import type { PlanReplay, SessionTaskSummary } from '@real-bot/protocol';
import { copyFor } from '../../src/lib/copy.ts';
import { AgentCallLog } from '../../src/lib/taskmap/live.svelte.ts';
import TaskMap from '../../src/lib/taskmap/TaskMap.svelte';
import { aBot, aDirect, aGroup, fakeRuntime } from '../../src/lib/test-fixtures.ts';

const title = '创意短片《明天见》：一只猫跑过一千三百年的中国画';
const T0 = Date.UTC(2026, 9, 21, 2, 0, 0);

function job(id: string, name: string): SessionTaskSummary {
  return {
    id, dir: `work/${name}`, title: name, session_id: 'g-1', closed_at: null, last_activity_at: '2026-10-21T08:00:00.000Z',
    goal: null, kind: null, status: 'active', ticket_counts: { todo: 2, doing: 1, review: 0, done: 3, parked: 0 }, turn_count: 12,
  };
}

/** Worked on in the group, in your direct with the reviewer and in the reviewer's direct with the director. */
function replay(id: string): PlanReplay {
  const call = (n: number, bot: string, session: string, path: string) => ({
    id: `call_${n}`, at: new Date(T0 + n * 10_000).toISOString(), bot_id: bot, turn_id: 'turn-1', task_id: id, tool: 'write_file',
    place: { zone: 'project' as const, path }, model: 'claude-opus-5-5', file: path.split('/').pop() ?? null, ok: true, duration_ms: 300,
    decision: null, session_id: session,
  });
  return {
    task_id: id, title, dir: 'work/明天见', truncated: false, bots: ['bot-1', 'bot-2'], sessions: ['g-1', 'dm-2', 'dm-3'],
    calls: [
      ...Array.from({ length: 6 }, (_, i) => call(i, 'bot-1', 'g-1', 'work/明天见/shots/a.png')),
      ...Array.from({ length: 4 }, (_, i) => call(6 + i, 'bot-2', 'dm-2', 'work/明天见/review/notes.md')),
      call(10, 'bot-2', 'dm-3', 'work/明天见/scratch/b.md'),
    ],
    said: [{ kind: 'say', at: new Date(T0).toISOString(), text: '做一支短片', session_id: 'g-1' }],
  };
}

/** `jobs`: one gives the head a bare heading, two the switcher's button and its list. */
export function taskmapHeadStory(width: number, height: number, jobs: 1 | 2) {
  const t = copyFor('zh');
  const group = aGroup({ id: 'g-1', name: '视频组' });
  const member = (id: string) => ({ member: id, joined_at: '2026-09-19T00:00:00.000Z', left_at: null });
  const sessions = [group, aDirect({ id: 'dm-2', participants: [member('user'), member('bot-2')] }), aDirect({ id: 'dm-3', participants: [member('bot-1'), member('bot-2')] })];
  const runtime = fakeRuntime({ sessions, bots: [aBot({ id: 'bot-1', name: '视频导演' }), aBot({ id: 'bot-2', name: '审核员' })] });
  const listed = [job('task-1', title), job('task-2', '剪预告')].slice(0, jobs);
  Reflect.set(runtime, 'client', {
    sessionTasks: async () => listed,
    planReplay: async (id: string) => replay(id),
    sessionReplay: async () => { throw new Error('a conversation with plans draws a plan'); },
  });
  Reflect.set(runtime, 'agentCalls', new AgentCallLog());
  return {
    component: TaskMap as never,
    props: { runtime, t, session: group, taskId: null, onTask: () => {} },
    width, height,
    // The jobs and the plan's replay arrive after mount: ready once the town stands.
    async afterMount(host: HTMLElement) {
      for (let i = 0; i < 80 && !host.querySelector('.tm-plate'); i += 1) await new Promise((r) => setTimeout(r, 25));
    },
  };
}
