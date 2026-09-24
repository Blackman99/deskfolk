import type { Attachment, Message } from '@real-bot/protocol';
import { handedOverPaths } from '../overlays/artifacts.ts';
import { extractAssociatedFiles } from '../chat/message-context-menu.ts';
import type { PaneContent } from './pane-content.ts';

/** What the shell needs from a mounted preview: to ask it before turning it to another file. */
export type PreviewHandle = {
  blocksClose: () => boolean;
  requestLeaveFromParent: (after: () => void) => void;
};

/** The stand-in for the file on screen when nothing the source handed over names it. */
const ON_SCREEN = 'virtual-preview-';

/** Keep a preview scoped to its source even when another conversation is active. */
export function previewContext(content: Extract<PaneContent, { kind: 'preview' }>, messages: Message[]) {
  const candidates = messages.filter((row) => !content.sessionId || row.session_id === content.sessionId);
  const owner = candidates.find((row) => row.id === content.messageId)
    ?? candidates.find((row) => row.attachments.some((att) => att.id === content.attachmentId))
    ?? (!content.messageId ? candidates.find((row) => row.attachments.some((att) => att.workspace_relpath === content.relpath)) : undefined);
  const paths = owner
    ? content.forceTree ? extractAssociatedFiles(owner) : handedOverPaths(owner.body ?? '', owner.attachments.map((att) => att.workspace_relpath))
    : [];
  // Older builds saved the on-screen stand-in back into the tab on every click, so each file you
  // had opened turned into one this message handed over, and reopened by its made-up id.
  const siblings: Attachment[] = (content.siblings ?? []).filter((att) => !att.id.startsWith(ON_SCREEN));
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
  const taskId = content.taskId ?? owner?.task_id ?? null;
  /** What the source handed over, and all a tab keeps: never the stand-in below. */
  const handedOver = [...siblings];
  // A lone file keeps its row in the tree. A job's tree already lists what the job cited, and a
  // stand-in there would mark whatever is on screen as handed over by this message.
  if (relpath && !taskId && !siblings.some((att) => att.workspace_relpath === relpath)) {
    siblings.push({ id: `${ON_SCREEN}${relpath}`, message_id: content.messageId ?? '',
      workspace_relpath: relpath, original_filename: relpath.split('/').pop() ?? relpath, created_at: '' });
  }
  return { relpath, attachment, siblings, handedOver, messageId: content.messageId ?? owner?.id ?? null, taskId };
}
