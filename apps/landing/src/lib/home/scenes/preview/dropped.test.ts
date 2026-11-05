import { describe, expect, test } from 'bun:test';
import { htmlDoc, markdownDoc, openFile } from './dropped';
import { TEXT_CAP } from '../../file-kind';

describe('dropped documents', () => {
  test('markdown becomes a locked document', () => {
    const doc = markdownDoc('# Hi\n\n- a');
    expect(doc).toContain('<h1>Hi</h1>');
    expect(doc).toContain('Content-Security-Policy');
  });
  test('html keeps its text and is locked first', () => {
    expect(htmlDoc('<b>x</b>').startsWith('<meta http-equiv="Content-Security-Policy"')).toBe(true);
  });
  test('a big text file is cut at the cap', async () => {
    const shown = await openFile(new File(['a'.repeat(TEXT_CAP + 10)], 'big.txt', { type: 'text/plain' }));
    expect(shown.truncated).toBe(true);
    expect(shown.text?.length).toBe(TEXT_CAP);
  });
  test('a small one is whole', async () => {
    const shown = await openFile(new File(['hello'], 'a.json'));
    expect(shown).toMatchObject({ kind: 'text', text: 'hello', truncated: false });
  });
  test('an office file has nothing to show but its kind', async () => {
    const shown = await openFile(new File(['x'], 'a.DOCX'));
    expect(shown).toMatchObject({ kind: 'office', ext: 'docx', url: null, text: null, srcdoc: null });
  });
});
