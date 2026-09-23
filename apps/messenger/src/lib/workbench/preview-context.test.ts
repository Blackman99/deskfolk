import { expect, test } from 'bun:test';
import { aMessage, anAttachment } from '../test-fixtures.ts';
import { contentOfTab, tabFor, type PaneContent } from './pane-content.ts';
import { previewContext } from './preview-context.ts';

const attachment = anAttachment({ id: 'a', message_id: 'm', workspace_relpath: 'work/a.md', original_filename: 'a.md' });
const message = aMessage({ id: 'm', session_id: 's', task_id: 'job', attachments: [attachment], body: '附件：work/b.md\nSee `work/reference.md`.' });
const content: Extract<PaneContent, { kind: 'preview' }> = {
  kind: 'preview', sessionId: 's', relpath: 'work/a.md', attachmentId: 'a',
  messageId: 'm', taskId: 'job', forceTree: true, siblings: [attachment],
};

test('preview context survives tab serialization and absent message history', () => {
  const restored = contentOfTab(JSON.parse(JSON.stringify(tabFor(content, 't'))))!;
  expect(restored).toEqual(content);
  if (restored.kind !== 'preview') throw new Error('preview expected');
  const context = previewContext(restored, []);
  expect(context.attachment).toEqual(attachment);
  expect(context.siblings).toEqual([attachment]);
  expect(context.taskId).toBe('job');
});

test('message handoffs and context-menu references stay scoped to the source session', () => {
  const other = aMessage({ id: 'other', session_id: 'other', task_id: 'wrong-job', attachments: [attachment] });
  expect(previewContext({ ...content, taskId: null, forceTree: false }, [other, message]).siblings.map((a) => a.workspace_relpath))
    .toEqual(['work/a.md', 'work/b.md']);
  const context = previewContext({ ...content, taskId: null }, [other, message]);
  expect(context.taskId).toBe('job');
  expect(context.siblings.map((a) => a.workspace_relpath)).toContain('work/reference.md');
});

test('legacy path tabs and attachment-only tabs recover their source', () => {
  expect(previewContext({ kind: 'preview', sessionId: 's', relpath: 'work/a.md', attachmentId: null }, [message]).siblings).toHaveLength(2);
  expect(previewContext({ ...content, relpath: null }, [message]).relpath).toBe('work/a.md');
});

test('malformed stored sibling data is ignored and an unlisted selection remains in the tree', () => {
  const restored = contentOfTab({ id: 't', kind: 'preview', params: { relpath: 'work/missing.md', siblings: '{' } });
  if (restored?.kind !== 'preview') throw new Error('preview expected');
  expect(restored.siblings).toBeNull();
  expect(previewContext(restored, []).siblings[0]?.workspace_relpath).toBe('work/missing.md');
});
