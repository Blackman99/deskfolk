import type { Attachment, Message } from '@real-bot/protocol';
import { handedOverPaths } from '../overlays/artifacts.ts';
import { extractAssociatedFiles } from '../chat/message-context-menu.ts';
import type { PaneContent } from './pane-content.ts';

/** What the shell needs from a mounted preview: to ask it before turning it to another file. */
export type PreviewHandle = {
  blocksClose: () => boolean;
  requestLeaveFromParent: (after: () => void) => void;
};

/** Keep a preview scoped to its source even when another conversation is active. */
export function previewContext(content: Extract<PaneContent, { kind: 'preview' }>, messages: Message[]) {
  const candidates = messages.filter((row) => !content.sessionId || row.session_id === content.sessionId);
  const owner = candidates.find((row) => row.id === content.messageId)
    ?? candidates.find((row) => row.attachments.some((att) => att.id === content.attachmentId))
    ?? (!content.messageId ? candidates.find((row) => row.attachments.some((att) => att.workspace_relpath === content.relpath)) : undefined);
  const paths = owner
    ? content.forceTree ? extractAssociatedFiles(owner) : handedOverPaths(owner.body ?? '', owner.attachments.map((att) => att.workspace_relpath))
    : [];
  const siblings: Attachment[] = [...(content.siblings ?? [])];
  for (const path of paths) {
    const attachment = owner!.attachments.find((att) => att.workspace_relpath === path) ?? {
      id: `virtual-${owner!.id}-${path}`, message_id: owner!.id,
      workspace_relpath: path, original_filename: path.split('/').pop() ?? path, created_at: owner!.created_at,
    };
    const index = siblings.findIndex((att) => att.workspace_relpath === path);
    if (index < 0) siblings.push(attachment);
    else siblings[index] = attachment;
  }
  const attachment = siblings.find((att) => att.id === content.attachmentId)
    ?? siblings.find((att) => att.workspace_relpath === content.relpath) ?? null;
  const relpath = content.relpath ?? attachment?.workspace_relpath ?? '';
  if (relpath && !siblings.some((att) => att.workspace_relpath === relpath)) {
    siblings.push({ id: `virtual-preview-${relpath}`, message_id: content.messageId ?? '',
      workspace_relpath: relpath, original_filename: relpath.split('/').pop() ?? relpath, created_at: '' });
  }
  return { relpath, attachment, siblings, messageId: content.messageId ?? owner?.id ?? null,
    taskId: content.taskId ?? owner?.task_id ?? null };
}
