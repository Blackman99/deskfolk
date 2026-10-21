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
  // Two Claude accounts and Claude Code's own models, so the composer's picker has all three columns.
  (runtime as unknown as { client: unknown }).client = {
    claudeCode: async () => ({ email: 'me@example.com', accounts: [{ config_dir: null, email: 'me@example.com' }, { config_dir: '/Users/me/.claude-team', email: 'team@example.com' }] }),
    claudeCodeModels: async (dir: string | null) => ({ config_dir: dir, checked_at: '2026-09-19T02:00:00.000Z', error: null, models: [
      { value: 'default', display_name: 'Default (recommended)', description: 'Opus 5.5 · Most capable for complex work', resolved_model: 'claude-opus-5-5', efforts: ['low', 'medium', 'high', 'xhigh', 'max'] },
      { value: 'fable', display_name: 'Fable 5.1', description: 'Fable 5.1 · Long-form writing', resolved_model: 'claude-fable-5-1', efforts: ['low', 'medium', 'high'] },
      { value: 'sonnet', display_name: 'Sonnet 5.5', description: 'Sonnet 5.5 · Best for everyday tasks', resolved_model: 'claude-sonnet-5-5', efforts: ['low', 'medium', 'high', 'max'] },
      { value: 'haiku', display_name: 'Haiku 5.5', description: 'Haiku 5.5 · Fastest for quick answers', resolved_model: 'claude-haiku-5-5', efforts: [] },
    ] }),
  };
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
