import { aBot, aBotDirect, aMessage, fakeRuntime } from '../../src/lib/test-fixtures.ts';
import { aDelegation } from '../../src/lib/test-delegations.ts';
import { reactive } from '../../src/lib/test-reactive.svelte.ts';
import { copyFor } from '../../src/lib/copy.ts';
import ChatStage from '../../src/lib/chat/ChatStage.svelte';

/** All records, paths, and names are synthetic; no daemon, paid model, or project database. */
export function delegationStory(locale: 'zh' | 'en') {
  const session = aBotDirect();
  const request = aDelegation({ request_message_id: 'linked-request', wait: { state: 'waiting', since: '2026-09-19T02:00:00.000Z', due_at: null } });
  const reply = aDelegation({ id: 'returned', ask: '审 Shot 12', status: 'replied', wait: null, result_message_id: 'linked-result',
    reply: { body: '2 通过 1 不通过\n\n[review.md](artifact:fixture%2Freview.md)\n\n<script>window.fixtureInjection=true</script>[unsafe](javascript:alert(1))', created_at: '2026-09-19T03:00:00.000Z', ref: null } });
  const runtime = reactive(fakeRuntime({ bots: [aBot({ name: '导演' }), aBot({ id: 'bot-2', name: '审片员' })], sessions: [session],
    turns: [], delegations: [reply, request], messages: [
      aMessage({ id: 'linked-request', session_id: session.id, author: 'bot-1', kind: 'bot', body: '审 Shot 11' }),
      aMessage({ id: 'linked-result', session_id: session.id, author: 'bot-2', kind: 'bot', body: '2 通过 1 不通过' }),
      aMessage({ id: 'ordinary-peer', session_id: session.id, author: 'bot-2', kind: 'bot', body: '收到。普通讨论里写着等待，并不建立委派。' }),
    ] }, { selectedId: session.id, remote: true }));
  return {
    component: ChatStage as never,
    props: { runtime, t: copyFor(locale), selected: session, onOpenProfile: () => {}, onCreateBot: () => {},
      onOpenArtifact: (path: string) => { document.body.dataset.openedArtifact = path; } },
    width: 900, height: 1100,
    afterMount(host: HTMLElement) {
      document.body.style.width = '100vw'; document.body.style.height = '100dvh'; host.style.width = '100vw'; host.style.height = '100dvh';
      // Browser events change persisted fixture views, not application mutation controls.
      host.addEventListener('fixture-held', () => { runtime.snapshot = { ...runtime.snapshot, delegations: [{ ...request, wait: { ...request.wait!, state: 'held' } }, reply] }; });
      host.addEventListener('fixture-continue', () => { runtime.snapshot = { ...runtime.snapshot, delegations: [{ ...request, wait: null }, reply] }; });
    },
  };
}
