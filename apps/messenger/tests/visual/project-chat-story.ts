/**
 * A project session's conversation (ADR 0095) as a pane holds it: the shell names the column a
 * `conversation` container, so the story does too, and a spec sets the width it wants to see.
 * Every line is a fixture.
 */
import { copyFor } from '../../src/lib/copy.ts';
import { aMessage, aProjectSession, fakeRuntime } from '../../src/lib/test-fixtures.ts';
import ProjectChat from '../../src/lib/chat/ProjectChat.svelte';

export function projectChatStory() {
  const session = aProjectSession();
  const runtime = fakeRuntime({
    sessions: [session],
    messages: [
      aMessage({ id: 'm1', session_id: session.id, body: '把登录循环修掉，再跑一遍测试', created_at: '2026-09-19T02:00:00.000Z' }),
      aMessage({ id: 'm2', session_id: session.id, kind: 'bot', author: 'agent', body: '**修好了**：会话过期时不再跳回登录页。测试全部通过。', created_at: '2026-09-19T02:00:05.000Z' }),
    ],
  });
  return {
    component: ProjectChat as never,
    props: { runtime, t: copyFor('zh'), selected: session, onOpenArtifact: () => {} },
    width: 500, height: 720,
    afterMount(host: HTMLElement) {
      host.style.display = 'flex';
      host.style.flexDirection = 'column';
      host.style.container = 'conversation / inline-size';
    },
  };
}
