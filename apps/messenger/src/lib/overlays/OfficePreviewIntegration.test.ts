import { expect, mock, test } from 'bun:test';
import { flushSync } from 'svelte';
import { copyFor } from '../copy.ts';
import { anAttachment } from '../test-fixtures.ts';
import { click, render } from '../test-render.ts';
import { closeFullscreenPreview } from './fullscreen-preview.ts';

mock.module('monaco-editor-css', () => ({}));
mock.module('monaco-editor/esm/vs/platform/hover/browser/hover.css', () => ({}));
mock.module('monaco-editor/esm/vs/base/browser/ui/contextview/contextview.css', () => ({}));
const { default: ArtifactPreview } = await import('./ArtifactPreview.svelte');
const { default: TraceOutput } = await import('./TraceOutput.svelte');
const t = copyFor('zh');

async function workbook(): Promise<Blob> {
  const excel = (await import('exceljs')).default;
  const book = new excel.Workbook();
  book.addWorksheet('First').getCell('A1').value = 'shared-preview-cell';
  book.addWorksheet('Second').getCell('A1').value = 'second-sheet-cell';
  const data = await book.xlsx.writeBuffer();
  return new Blob([new Uint8Array(data)]);
}

async function settle(host: HTMLElement, text: string) {
  for (let i = 0; i < 200; i++) {
    flushSync();
    if (host.textContent?.includes(text)) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Preview did not show ${text}`);
}

for (const mode of ['cited', 'workspace', 'trace'] as const) {
  test(`${mode} opens the shared Office viewer through the expected file API`, async () => {
    const blob = await workbook();
    const calls: string[] = [];
    const api = {
      kind: 'local',
      getAttachmentBlob: async (id: string) => { calls.push(`attachment:${id}`); return blob; },
      getWorkspaceFileBlob: async (path: string) => { calls.push(`workspace:${path}`); return blob; },
      workspaceTree: async () => ({ items: [], truncated: false }),
    };
    const attachment = anAttachment({ id: 'office-att', original_filename: 'report.xlsx', workspace_relpath: 'report.xlsx' });
    const view = mode === 'trace'
      ? render(TraceOutput, { path: 'report.xlsx', handedBy: '', api: api as never, workspacePath: '/workspace', t, onOpenPath: () => {}, onClose: () => {} })
      : render(ArtifactPreview, { attachment, relpath: 'report.xlsx', siblings: [attachment], api: api as never, workspacePath: '/workspace', t, mode, onSelect: () => {}, onClose: () => {} });
    try {
      await settle(view.host, 'shared-preview-cell');
      expect(calls).toEqual([mode === 'cited' ? 'attachment:office-att' : 'workspace:report.xlsx']);
      click([...view.host.querySelectorAll('button')].find((button) => button.textContent === 'Second'));
      await settle(view.host, 'second-sheet-cell');
      expect(view.host.textContent).not.toContain('shared-preview-cell');
      expect(view.host.querySelector('.artifact-cm')).toBeNull();
      const root = view.host.querySelector<HTMLElement>('.office-viewer')!;
      root.showPopover = () => {};
      root.hidePopover = () => {};
      click(view.host.querySelector('.office-full'));
      expect(root.classList.contains('is-enlarged')).toBe(true);
      expect(root.textContent).toContain('second-sheet-cell');
      click(view.host.querySelector('.office-full'));
      expect(root.classList.contains('is-enlarged')).toBe(false);
      click(view.host.querySelector('.office-full'));
      expect(closeFullscreenPreview()).toBe(true);
      flushSync();
      expect(root.classList.contains('is-enlarged')).toBe(false);
      expect(root.textContent).toContain('second-sheet-cell');
      expect(closeFullscreenPreview()).toBe(false);
      expect(calls).toHaveLength(1);
    } finally {
      view.close();
    }
  });
}
