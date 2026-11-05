import { describe, expect, test } from 'bun:test';
import { classify, extOf, mustCap, TEXT_CAP } from './file-kind';

describe('extOf', () => {
  test('lower-cases and takes the last dot', () => {
    expect(extOf('A.B.PNG')).toBe('png');
    expect(extOf('archive.tar.gz')).toBe('gz');
  });
  test('no extension, trailing dot, paths', () => {
    expect(extOf('README')).toBe('');
    expect(extOf('name.')).toBe('');
    expect(extOf('dir.d/file')).toBe('');
    expect(extOf('C:\\x\\y.MD')).toBe('md');
  });
  test('a dotfile is its own extension', () => {
    expect(extOf('.env')).toBe('env');
  });
});

describe('classify by extension', () => {
  const table: [string, string][] = [
    ['png jpg jpeg gif webp avif bmp svg', 'image'],
    ['mp4 webm mov m4v', 'video'],
    ['mp3 wav m4a aac ogg flac', 'audio'],
    ['pdf', 'pdf'],
    ['md markdown', 'markdown'],
    ['html htm', 'html'],
    ['txt json yaml yml toml ts tsx js jsx mjs py rs go java kt swift c h cpp hpp cs css scss svelte vue sh zsh rb php sql csv log xml ini env conf', 'text'],
    ['docx xlsx pptx doc xls ppt', 'office']
  ];
  for (const [exts, kind] of table) {
    for (const ext of exts.split(' ')) {
      test(`.${ext} is ${kind}`, () => {
        expect(classify(`file.${ext}`, '').kind).toBe(kind as never);
        expect(classify(`FILE.${ext.toUpperCase()}`, '').kind).toBe(kind as never);
      });
    }
  }
  test('upper-case SVG', () => {
    expect(classify('Logo.SVG', '')).toEqual({ kind: 'image', ext: 'svg' });
  });
  test('the extension beats a misleading MIME type', () => {
    expect(classify('main.ts', 'video/mp2t').kind).toBe('text');
    expect(classify('notes.md', 'application/octet-stream').kind).toBe('markdown');
  });
});

describe('classify by MIME', () => {
  test('no extension falls back to the type', () => {
    expect(classify('README', 'text/plain').kind).toBe('text');
    expect(classify('photo', 'image/png').kind).toBe('image');
    expect(classify('clip', 'video/quicktime').kind).toBe('video');
    expect(classify('song', 'audio/mpeg').kind).toBe('audio');
    expect(classify('doc', 'application/pdf').kind).toBe('pdf');
    expect(classify('page', 'text/html; charset=utf-8').kind).toBe('html');
    expect(classify('x', 'text/markdown').kind).toBe('markdown');
    expect(classify('x', 'application/json').kind).toBe('text');
    expect(classify('x', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document').kind).toBe('office');
    expect(classify('x', 'application/msword').kind).toBe('office');
  });
  test('unknown extension with a text type is text', () => {
    expect(classify('data.weird', 'text/x-custom').kind).toBe('text');
  });
  test('nothing known is unknown', () => {
    expect(classify('README', '')).toEqual({ kind: 'unknown', ext: '' });
    expect(classify('a.zip', 'application/zip').kind).toBe('unknown');
    expect(classify('a.exe', 'application/x-msdownload').kind).toBe('unknown');
  });
});

describe('mustCap', () => {
  test('only text kinds over the cap', () => {
    expect(mustCap('text', TEXT_CAP)).toBe(false);
    expect(mustCap('text', TEXT_CAP + 1)).toBe(true);
    expect(mustCap('markdown', TEXT_CAP + 1)).toBe(true);
    expect(mustCap('html', TEXT_CAP + 1)).toBe(true);
    expect(mustCap('image', TEXT_CAP * 100)).toBe(false);
    expect(mustCap('pdf', TEXT_CAP * 100)).toBe(false);
  });
});
