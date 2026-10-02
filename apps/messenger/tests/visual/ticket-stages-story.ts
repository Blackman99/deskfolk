import type { TaskDetail, TicketWithArtifacts } from '@real-bot/protocol';
import { aBot } from '../../src/lib/test-fixtures.ts';
import { copyFor } from '../../src/lib/copy.ts';
import TicketList from '../../src/lib/overlays/TicketList.svelte';

function ticket(over: Partial<TicketWithArtifacts>): TicketWithArtifacts {
  return {
    id: 'ticket', task_id: 'fixture-plan', seq: 1, title: '分镜', slug: '01', dir: 'work/fixture/01', spec: '', status: 'doing',
    worker: 'bot-1', created_at: '2026-10-01T00:00:00.000Z', updated_at: '2026-10-01T00:00:00.000Z', closed_at: null, artifacts: [], ...over,
  };
}

/** Synthetic board ticket list at engine level 5 (ADR 0046): stages beside statuses, parts passed; no daemon or real data. */
export function ticketStagesStory(locale: 'zh' | 'en') {
  const t = copyFor(locale);
  const detail = {
    id: 'fixture-plan', dir: 'work/fixture', title: 'Synthetic film', session_id: 'group-1', closed_at: null,
    last_activity_at: '2026-10-01T00:00:00.000Z', goal: 'A synthetic film', kind: null, status: 'active', submissions_on: true, reviewer_ids: ['bot-1', 'bot-2'],
    ticket_counts: { todo: 1, doing: 1, review: 2, done: 1, parked: 0 }, brief: null, spec: null, spec_updated_at: null,
    revision: 1, revision_actor: 'app', routine_id: null,
    tickets: [
      ticket({ id: 't1', seq: 1, title: '分镜 Storyboard', status: 'review', stage: 'in_review', reviewer_bot_id: 'bot-2', parts: { total: 12, approved: 11 } }),
      ticket({ id: 't2', seq: 2, title: '母带 Master cut with a long title that has to wrap on a phone', status: 'doing', stage: 'rework' }),
      ticket({ id: 't3', seq: 3, title: '配乐', status: 'review', stage: 'submitted' }),
      ticket({ id: 't4', seq: 4, title: '海报', status: 'done', stage: 'approved', parts: { total: 3, approved: 3 } }),
      ticket({ id: 't5', seq: 5, title: '字幕', status: 'todo', worker: null }),
    ],
  } as unknown as TaskDetail;
  return {
    component: TicketList as never,
    props: {
      // A synthetic API: a menu change is recorded on the page, never sent anywhere.
      api: { patchTicket: async (id: string, body: unknown) => { document.body.dataset.ticketPatches = JSON.stringify([...JSON.parse(document.body.dataset.ticketPatches ?? '[]'), { id, body }]); return detail.tickets.find((row) => row.id === id)!; } },
      detail, nodes: [], bots: [aBot({ id: 'bot-1', name: '视频导演' }), aBot({ id: 'bot-2', name: '审片员' })], youLabel: locale === 'en' ? 'You' : '你',
      deletedLabel: locale === 'en' ? 'Deleted' : '已删除', t, selectedId: null,
      onSelect: () => {}, onJump: () => {}, onOpenArtifacts: () => {}, onPatched: () => {}, onConflict: () => {},
    },
    width: 900, height: 700,
    // The list as wide as the viewport, so a phone width is checked as a phone shows it.
    afterMount(host: HTMLElement) { document.body.style.width = '100vw'; host.style.width = '100vw'; host.style.height = 'auto'; },
  };
}
