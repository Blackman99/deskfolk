/**
 * Line diffs and a three-way line merge, shared by the daemon (a built-in prompt you edited, merged
 * onto a newer default: ADR 0064) and the messenger (before/after views). A longest common
 * subsequence over lines: the texts are prompts and skills, a few hundred lines at most, so the
 * table stays small.
 */

export type DiffLine = { kind: "same" | "del" | "add" | "gap"; text: string };

function lcsTable(a: readonly string[], b: readonly string[]): number[][] {
  const table: number[][] = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      table[i]![j] = a[i] === b[j] ? table[i + 1]![j + 1]! + 1 : Math.max(table[i + 1]![j]!, table[i]![j + 1]!);
    }
  }
  return table;
}

/** Every line of `before` and `after` in order: kept, taken out, or put in. */
export function diffLines(before: string, after: string): Array<{ kind: "same" | "del" | "add"; text: string }> {
  const a = before.split("\n");
  const b = after.split("\n");
  const table = lcsTable(a, b);
  const all: Array<{ kind: "same" | "del" | "add"; text: string }> = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      all.push({ kind: "same", text: a[i]! });
      i += 1;
      j += 1;
    } else if (table[i + 1]![j]! >= table[i]![j + 1]!) {
      all.push({ kind: "del", text: a[i]! });
      i += 1;
    } else {
      all.push({ kind: "add", text: b[j]! });
      j += 1;
    }
  }
  while (i < a.length) all.push({ kind: "del", text: a[i++]! });
  while (j < b.length) all.push({ kind: "add", text: b[j++]! });
  return all;
}

/**
 * Before and after, line by line: what was taken out, what was put in, and a gap mark where
 * unchanged lines were left out.
 */
export function changedLines(before: string, after: string): DiffLine[] {
  const out: DiffLine[] = [];
  for (const line of diffLines(before, after)) {
    if (line.kind !== "same") out.push(line);
    else if (out.length > 0 && out[out.length - 1]!.kind !== "gap") out.push({ kind: "gap", text: "" });
  }
  while (out.length > 0 && out[out.length - 1]!.kind === "gap") out.pop();
  return out;
}

/** Index pairs (line of `a`, line of `b`) of one longest common subsequence, in order. */
function commonLines(a: readonly string[], b: readonly string[]): Map<number, number> {
  const table = lcsTable(a, b);
  const pairs = new Map<number, number>();
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      pairs.set(i, j);
      i += 1;
      j += 1;
    } else if (table[i + 1]![j]! >= table[i]![j + 1]!) i += 1;
    else j += 1;
  }
  return pairs;
}

function sameLines(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((line, i) => line === b[i]);
}

export type Merge3Result = { clean: true; text: string } | { clean: false; conflicts: number };

/**
 * Three-way merge by line: what `ours` changed from `base` and what `theirs` changed from it, put
 * together. A run of lines only one side changed takes that side; both sides making the same change
 * is fine; both changing the same run differently is a conflict, and a merge with any conflict gives
 * no text. Base lines both sides kept, blank ones included, split the texts into those runs.
 */
export function merge3Lines(base: string, ours: string, theirs: string): Merge3Result {
  if (ours === theirs || theirs === base) return { clean: true, text: ours };
  if (ours === base) return { clean: true, text: theirs };
  const b = base.split("\n");
  const o = ours.split("\n");
  const t = theirs.split("\n");
  const toOurs = commonLines(b, o);
  const toTheirs = commonLines(b, t);
  const out: string[] = [];
  let conflicts = 0;
  let bi = 0;
  let oi = 0;
  let ti = 0;
  const run = (bEnd: number, oEnd: number, tEnd: number) => {
    const bRun = b.slice(bi, bEnd);
    const oRun = o.slice(oi, oEnd);
    const tRun = t.slice(ti, tEnd);
    if (sameLines(oRun, bRun)) out.push(...tRun);
    else if (sameLines(tRun, bRun) || sameLines(oRun, tRun)) out.push(...oRun);
    else conflicts += 1;
  };
  for (let k = 0; k < b.length; k++) {
    const oj = toOurs.get(k);
    const tj = toTheirs.get(k);
    if (oj === undefined || tj === undefined) continue;
    run(k, oj, tj);
    out.push(b[k]!);
    bi = k + 1;
    oi = oj + 1;
    ti = tj + 1;
  }
  run(b.length, o.length, t.length);
  return conflicts === 0 ? { clean: true, text: out.join("\n") } : { clean: false, conflicts };
}
