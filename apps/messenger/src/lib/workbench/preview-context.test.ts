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

test('an on-screen stand-in saved by an older build is dropped and never picked as the attachment', () => {
  // What older builds wrote back after a click: the file on screen, under a made-up id.
  const standIn = { id: 'virtual-preview-work/c.md', message_id: 'm', workspace_relpath: 'work/c.md', original_filename: 'c.md', created_at: '' };
  const context = previewContext({ ...content, relpath: 'work/c.md', attachmentId: standIn.id, siblings: [attachment, standIn] }, []);
  expect(context.attachment).toBeNull();
  expect(context.siblings.map((a) => a.workspace_relpath)).toEqual(['work/a.md']);
  expect(context.handedOver).toEqual([attachment]);
});

test('what a tab keeps never includes the stand-in for the file on screen', () => {
  const context = previewContext({ ...content, taskId: null, relpath: 'work/c.md', attachmentId: null }, []);
  expect(context.siblings.map((a) => a.workspace_relpath)).toContain('work/c.md');
  expect(context.handedOver.map((a) => a.workspace_relpath)).toEqual(['work/a.md']);
});

test('in a job the file on screen is not stood in as one this message handed over', () => {
  const context = previewContext({ ...content, relpath: 'work/c.md', attachmentId: null }, []);
  expect(context.siblings.map((a) => a.workspace_relpath)).toEqual(['work/a.md']);
  expect(previewContext({ ...content, taskId: null, relpath: 'work/c.md', attachmentId: null }, []).siblings.map((a) => a.workspace_relpath))
    .toEqual(['work/a.md', 'work/c.md']);
});

test('malformed stored sibling data is ignored and an unlisted selection remains in the tree', () => {
  const restored = contentOfTab({ id: 't', kind: 'preview', params: { relpath: 'work/missing.md', siblings: '{' } });
  if (restored?.kind !== 'preview') throw new Error('preview expected');
  expect(restored.siblings).toBeNull();
  expect(previewContext(restored, []).siblings[0]?.workspace_relpath).toBe('work/missing.md');
});
