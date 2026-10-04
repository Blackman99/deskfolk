/**
 * Shot numbers in a name: 「第 3 镜」, `Shot 07`, `C07`, `shot_07.mp4`. Two places still read them,
 * and neither decides what a line of yours or a delivered file is about (ADR 0057: a model reads
 * which job, ticket and part a line is about; a Bot names the parts it hands over):
 *
 * - `plan_items` keys the parts the lead declares by their number, so 「Shot 07」 and 「C07」 are one
 *   part (`shot_07`) rather than two;
 * - the external-job guard (ADR 0047) keeps one render running per shot, by the shot number its
 *   prompt names.
 */

const CN: Record<string, number> = { 零: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
const NUMBER = '[零一二两三四五六七八九十百\\d]+';
const PART_WORD = new RegExp(`前\\s*(${NUMBER})\\s*镜|第\\s*(${NUMBER})\\s*镜|(?<![a-z])(?:shot|镜头?|c)\\s*[ _-]?\\s*0*(\\d{1,3})(?:\\s*[–—-]\\s*0*(\\d{1,3}))?(?!\\d)|(?<!\\d)(\\d{1,3})\\s*[–—-]\\s*(\\d{1,3})(?!\\d)`, 'gi');

/** One bounded numbering system, 1..999; ranges and Chinese tens use exactly the same numbers. */
export function partNumbers(body: string): number[] {
  const found = new Set<number>();
  const range = (from: number, to: number) => {
    if (from < 1 || to > 999 || from > to) return;
    for (let n = from; n <= to; n++) found.add(n);
  };
  for (const match of body.matchAll(PART_WORD)) {
    if (match[1]) range(1, numberOf(match[1]));
    else if (match[2]) range(numberOf(match[2]), numberOf(match[2]));
    else if (match[3]) range(Number(match[3]), Number(match[4] ?? match[3]));
    else if (match[5] && match[6]) range(Number(match[5]), Number(match[6]));
  }
  return [...found].sort((a, b) => a - b);
}

function numberOf(text: string): number {
  if (/^\d+$/.test(text)) return Number(text);
  let result = 0;
  let digit = 0;
  for (const char of text) {
    if (char === '十' || char === '百') { result += (digit || 1) * (char === '十' ? 10 : 100); digit = 0; }
    else digit = CN[char] ?? 0;
  }
  return result + digit;
}

/** The shot numbers a name gives (a file's, or a part's): `shot_07`, `C07`, `镜头7`, `第七镜`. */
export function filenamePartNumbers(path: string): number[] {
  const filename = path.split('/').at(-1) ?? '';
  const found = new Set<number>();
  for (const match of filename.matchAll(/(?<![a-z])(?:shot|c|镜头?)[ _-]?0*(\d{1,3})(?!\d)/gi)) found.add(Number(match[1]));
  for (const match of filename.matchAll(/第?([零一二两三四五六七八九十百]+)镜|镜头?([零一二两三四五六七八九十百]+)/g)) found.add(numberOf(match[1] ?? match[2]!));
  return [...found].filter((n) => n >= 1 && n <= 999).sort((a, b) => a - b);
}
