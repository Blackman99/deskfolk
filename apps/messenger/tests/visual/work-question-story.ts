import type { WorkAnswerResult, WorkQuestionControl } from '@real-bot/protocol';
import { ApiError } from '../../src/lib/api.ts';
import { aBot, aDirect, aGroup, aHold, aMessage, aTurn, fakeRuntime } from '../../src/lib/test-fixtures.ts';
import { reactive } from '../../src/lib/test-reactive.svelte.ts';
import { copyFor } from '../../src/lib/copy.ts';
import { LocalApi } from '../../src/lib/local-api.ts';
import { MessengerRuntime } from '../../src/lib/runtime.svelte.ts';
import ChatStage from '../../src/lib/chat/ChatStage.svelte';

/** Synthetic browser seam: actual ChatStage + runtime + generic receipt POST, no daemon or real data. */
export function workQuestionStory(locale: 'zh' | 'en') {
  const phone = locale === 'en';
  const session = phone ? aDirect() : aGroup({ name: 'Synthetic trailer project' });
  const control: WorkQuestionControl = { kind: 'work_question', work_item_id: 'fixture-work', task_id: 'fixture-plan', ticket_id: 'fixture-ticket', question: '片长要多少？\nWhich aspect ratio? 🦊', offer: [] };
  const message = aMessage({ id: 'fixture-question', session_id: session.id, kind: 'system', author: 'bot-1', turn_id: 'fixture-ended-turn', body: 'Do not render this generic line', control });
  const answeredMessage = (body: string) => ({ ...message, control: { ...control, answer: { body, at: '2026-10-01T02:00:00.000Z', user_action_id: 'fixture-action', inbox_seq: 12 } } });
  const transportRuntime = new MessengerRuntime();
  Reflect.set(transportRuntime, 'api', new LocalApi({ origin: 'http://fixture.local', token: 'synthetic' }));
  transportRuntime.connection = 'connected';
  transportRuntime.snapshot.messages = [message];
  transportRuntime.snapshot.sessions = [session];
  let refused = false;
  let holdResponse = false;
  let release: (() => void) | null = null;
  let persisted = message;
  document.body.dataset.workAnswerCalls = '[]';
  const fixtureFetch: typeof fetch = async (input, init) => {
    const request = new Request(input, init);
    if (!new URL(request.url).pathname.endsWith('/work-answer')) throw new Error('Unexpected fixture request');
    const body = JSON.parse(String(init?.body)).body as string;
    const calls = JSON.parse(document.body.dataset.workAnswerCalls!);
    calls.push({ method: request.method, path: new URL(request.url).pathname, body, id: request.headers.get('X-Request-Id') });
    document.body.dataset.workAnswerCalls = JSON.stringify(calls);
    if (refused) return Response.json({ error: { code: 'work_closed', message: 'Synthetic work closed' } }, { status: 409 });
    persisted = answeredMessage(body);
    if (holdResponse) await new Promise<void>((done) => { release = done; });
    const result: WorkAnswerResult = { message: persisted, work_item_id: 'fixture-work', inbox_state: 'held', answered: true };
    return Response.json(result);
  };
  const runtime = reactive(fakeRuntime({ bots: [aBot({ name: 'Synthetic Director' })], sessions: [session], messages: [message], holds: [aHold()], holdsOn: true,
    turns: [aTurn({ id: 'fixture-ended-turn', session_id: session.id, status: 'completed', pending_ask_id: null })],
  }, { selectedId: session.id, remote: phone, answerWorkQuestion: async (id: string, body: string) => {
    const result = await transportRuntime.answerWorkQuestion(id, body);
    if (!(result instanceof ApiError)) runtime.snapshot = { ...runtime.snapshot, messages: transportRuntime.snapshot.messages };
    return result;
  } }));
  runtime.attributionPlans = { [session.id]: [{ id: 'fixture-plan', title: 'Synthetic Trailer', tickets: [{ id: 'fixture-ticket', title: 'Vertical cut' }] }] };
  return {
    component: ChatStage as never,
    props: { runtime, t: copyFor(locale), selected: session, onOpenProfile: () => {}, onCreateBot: () => {}, onOpenArtifact: () => {} },
    width: phone ? 390 : 1100, height: phone ? 844 : 900,
    afterMount(host: HTMLElement) {
      globalThis.fetch = fixtureFetch;
      document.body.style.width = '100vw'; document.body.style.height = '100dvh'; host.style.width = '100vw'; host.style.height = '100dvh';
      host.addEventListener('fixture-refuse', () => { refused = true; });
      host.addEventListener('fixture-allow', () => { refused = false; });
      host.addEventListener('fixture-defer', () => { holdResponse = true; });
      host.addEventListener('fixture-release', () => { release?.(); });
      host.addEventListener('fixture-catchup', () => { runtime.snapshot = { ...runtime.snapshot, messages: [persisted] }; });
      // A browser reload's authoritative saved message, not transient submitted input.
      host.addEventListener('fixture-reload-answer', () => { runtime.snapshot = { ...runtime.snapshot, messages: [answeredMessage(' saved on another device\n✅ ')] }; });
    },
  };
}
