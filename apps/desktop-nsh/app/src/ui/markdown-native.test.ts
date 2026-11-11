/**
 * `prepareMarkdown` in Rust (`app/native/src/markdown`) against the TypeScript it replaces
 * (`prepareMarkdownJs`): the same strings, byte for byte, over the texts of the messenger's own
 * tests, a table of tricky ones and a few thousand generated from the pieces Markdown breaks on,
 * under several rosters, extra paths and hidden files. Run in the app's own engine, as the app
 * runs it. The last test times both.
 */
import { expect, test } from "nsh/test";
import { Markdown } from "deskfolk/native";
import { TEST_LITERALS } from "./markdown-native.corpus";
import { prepareMarkdownJs, type RenderMarkdownOptions } from "./markdown";

const native = (source: string, options: RenderMarkdownOptions, hidden: string[]): string =>
  Markdown.prepareMarkdown(source, JSON.stringify(options), hidden);

const bots = [
  { id: "b1", name: "Bob" },
  { id: "b2", name: "分镜师" },
  { id: "b 3", name: "3D师" },
  { id: "b4", name: "İstanbul" },
];
const members = [
  { id: "m1", name: "审稿员" },
  { id: "m2", name: "Ada" },
  { id: "m3", name: "Adam" },
];
const withBots = { mentionBots: bots, mentionMembers: members };
const ex = (extraPaths: string[]) => ({ extraPaths });
type Case = [string, string, RenderMarkdownOptions, string[]];

/** Tricky inputs, each with the options and hidden files it is read under. */
const TRICKY: Case[] = [
  ["empty source with extra paths", "", ex(["a.md"]), []],
  ["a bare path, a code span that is a path, one that is a command", "Open src/app.ts, `README.md` and `cat src/app.ts`.", ex(["src/app.ts"]), []],
  ["a path glued to word characters is not linked, one next to CJK is", "xsrc/app.ts src/app.ts.bak 看src/app.ts了 src/app.ts。", ex(["src/app.ts"]), []],
  ["longer known paths win, spaces go in angle brackets", "out/my file.md and out/my file.md.bak and out/a.md", ex(["out/a.md", "out/my file.md"]), []],
  ["fenced code is left alone, and so is an unclosed fence's rest", "see a/b.md\n```\na/b.md @Bob\n```\nthen ~~~\nc/d.md\n", withBots, []],
  ["a fence closed only by at least as many marks", "````\n```\nx/y.md\n````\nz/w.md\n", ex([]), []],
  ["tildes do not close backticks, an indented closing fence does", "```\nq/r.md\n~~~\n   ```\n@Bob q/r.md", withBots, []],
  ["code spans of several backticks", "`` a ` b/c.md `` and ``x`` and `unclosed b/c.md and ```y``` b/d.md", ex([]), []],
  ["a link with escaped brackets and a link with an angle href", "[a\\]b\\[c](out/x.md) and [name](<out/my file.md>) and [x](<>)", ex([]), []],
  ["images are not chips, the link inside a bang-bracket is", "![img](out/a.png) and ![[w](out/w.md)", ex([]), []],
  ["a link whose label has a backslash before a newline does not parse", "[a\\\nb](out/x.md) [c\\d](out/y.md)", ex([]), []],
  ["a link across lines", "[a\nb](out/x.md)", ex([]), []],
  ["urls and anchors stay links", "[a](https://x.com/a.md) [b](#top) [c](?q=1.md) [d](mailto:a@b.md)", ex([]), []],
  ["artifact hrefs, percent-encoded twice, and a broken escape", "[a](artifact:out%2Fa.md) [b](artifact:%25E4%25BD%25A0.md) [c](artifact:%zz.md) [d](artifact:)", ex([]), []],
  ["windows paths and backslash-relative ones", "C:\\Users\\me\\a.txt src\\foo.ts and `.\\notes\\a.md` and `a \\ b`", ex(["C:\\Users\\me\\a.txt", "src\\foo.ts"]), []],
  ["host absolute paths in code spans", "`/Users/me/site/index.html` `/sidebar` `/tmp/out/` `~/n.md` `//x/y`", ex([]), []],
  ["roster mentions resolved by name, longest first", "@Bob hi, @分镜师请出图，@3D师 and @everyone", withBots, []],
  ["mentions of a member and of a misspelt name", "@审稿 @Ad @Adam @Ada @分镜 @分 @İstan @istan", withBots, []],
  ["unresolved tokens, digits, glued @, joined @A/@B", "@Nobody user@host.com @14:30 @37.79s a/@Bob @Bob/@分镜师 @scope/pkg [@x](p.md)", withBots, []],
  ["a mention inside code and inside a link target", "`@Bob` [@Bob](x/@Bob.md) (@Bob) @Bob.", withBots, []],
  ["mentions without bots are left, even with members", "@Ada @Bob", { mentionMembers: members }, []],
  ["a bot with brackets and slash in its name and id", "@x[y] @A\\B", { mentionBots: [{ id: "a/b é", name: "x[y]" }, { id: "i2", name: "A\\B" }] }, []],
  ["standalone link lines of hidden files are dropped", "intro\n[out/a.md](out/a.md)\n  [out/b.md](out/b.md)  \n[other](out/a.md)\n![i](out/a.md)\nend [out/a.md](out/a.md)\n", ex([]), ["out/a.md"]],
  ["hidden with an escaped label and an angle path", "[out/my\\ file.md](<out/my file.md>)\nkept", ex([]), ["out/my file.md"]],
  ["hidden line inside a code span stays", "`\n[out/a.md](out/a.md)\n`\n[out/a.md](out/a.md)", ex([]), ["out/a.md"]],
  ["placeholders written in the source are replaced like the JavaScript does", "x \u0000C0\u0000 y `a` \u0000C1\u0000 \u0000L0\u0000 \u0000C99999999999999999999\u0000 \u0000M0\u0000", withBots, []],
  ["the placeholder test: a path named L0", "L0 `b/c.md` L0", ex(["L0"]), []],
  ["white space the JavaScript knows and Rust does not", "[a](x.md)\ufeff\n\ufeff[b](out/a.md)\u00a0\n \u2028[c](out/a.md)\u3000", ex([]), ["out/a.md"]],
  ["CJK, emoji and astral characters around chips", "😀 `文档/报告.md` 😀@Bob😀 [名字](文档/报告.md)。@分镜师\u{1F600}", withBots, []],
  ["entities in chip names and paths", "[a & <b> \"c\"](out/a&b.md) @Bob", withBots, []],
  ["bot: hrefs, decoded and broken", "[a](bot:b1) [b](bot:%E4%BD%A0) [c](bot:%zz) [d](bot:) [e](<bot:x y>)", ex([]), []],
  ["crlf lines", "a\r\n```\r\nb/c.md\r\n```\r\n[out/a.md](out/a.md)\r\n", ex([]), ["out/a.md"]],
  ["a code span with a newline is not one", "`a\nb/c.md`", ex([]), []],
  ["extra paths: blanks, repeats, padded", "a.md b.md", ex(["", " a.md ", "a.md", "  ", "b.md"]), []],
];

const NAMES = ["Bob", "分镜师", "分镜", "3D师", "Alice Smith", "审稿员", "a", "İstanbul", "ß", "Bo", "every", "everyone2", "x[y]", "Z\\z", "😀bot", "Éclair"];
const roster = (names: string[]) => names.map((name, i) => ({ id: `id${i}${i % 3 ? "" : " é/ü"}`, name }));
const PATHS = ["src/app.ts", "out/mock.png", "a b.md", "report.md", "./notes/a.txt", "C:\\x\\y.txt", "~/n.md", "/tmp/out/index.html", "work/审片/a.jpg", "L0", "a"];
const CONFIGS: RenderMarkdownOptions[] = [
  {},
  { extraPaths: PATHS },
  { extraPaths: ["a b.md", "src/a.ts", " x/y.md ", "", "report.md", "L0"] },
  { mentionBots: roster(NAMES.slice(0, 5)), mentionMembers: roster(NAMES.slice(5, 12)) },
  { mentionBots: roster(NAMES), mentionMembers: roster(NAMES.slice(3)), extraPaths: PATHS.slice(0, 5) },
  { mentionBots: [], mentionMembers: roster(NAMES) },
  {
    mentionBots: [{ id: "dup1", name: "Bob" }, { id: "dup2", name: "Bob" }, { id: "e", name: "" }],
    mentionMembers: [{ id: "m", name: "Bobby" }, { id: "m2", name: "Bobs" }],
  },
];
const HIDDEN = [[], [], [...PATHS, "a.md", "out/x.png", "x y.md"]];

const FRAGMENTS = [
  "`", "``", "```", "~~~", "\n", "\r\n", " ", "  ", "[", "]", "(", ")", "<", ">", "!", "\\", "@", "@Bob", "@分镜师", "@everyone", "@分镜",
  "@3D", "@x", "@Bo", "Bob", "src/a.ts", "a/b.md", "report.md", "./x.md", "C:\\x\\y.txt", "/tmp/out/a.html", "a b.md",
  "artifact:a%2Fb.md", "bot:id1", "bot:%E4%BD%A0", "bot:%zz", "[a](b)", "[a](<b c.md>)", "![i](p.png)", "](", "](<", ">)",
  "中文", "😀", "\u0000", "\u0000L0\u0000", "\u0000C1\u0000", "\u0000M0\u0000", "\u00a0", "\ufeff", "\u2028", "&", "\"", "-", "_", ".",
  ",", "/", ":", "，", "。", "%", "%41", "x", "y.md", "a", "L0", "id0", "~",
];

/** A repeatable stream of texts from the pieces Markdown breaks on. */
function generated(count: number, longest: number, seed: number): string[] {
  let state = seed;
  const next = (n: number) => {
    state = (Math.imul(state, 1103515245) + 12345) & 0x7fffffff;
    return state % n;
  };
  const out: string[] = [];
  for (let i = 0; i < count; i++) {
    let s = "";
    const pieces = 1 + next(longest);
    for (let j = 0; j < pieces; j++) s += FRAGMENTS[next(FRAGMENTS.length)]!;
    out.push(s);
  }
  return out;
}

type Mismatch = { source: string; options: string; hidden: string[]; js: string; native: string };

/** Runs one input through both; `undefined` when they agree (or when the TypeScript itself overflows its stack on a text that makes its placeholders loop). */
function compare(source: string, options: RenderMarkdownOptions, hidden: string[]): Mismatch | undefined {
  let js: string;
  try {
    js = prepareMarkdownJs(source, options, hidden);
  } catch {
    return undefined;
  }
  const rust = native(source, options, hidden);
  return rust === js ? undefined : { source, options: JSON.stringify(options), hidden, js, native: rust };
}

function check(name: string, run: (add: (m: Mismatch | undefined) => void) => void): void {
  const bad: Mismatch[] = [];
  let total = 0;
  run((m) => {
    total++;
    if (m) bad.push(m);
  });
  const shown = bad.slice(0, 3).map((m) => JSON.stringify(m)).join("\n");
  expect(`${name}: ${bad.length} of ${total} differ\n${shown}`).toBe(`${name}: 0 of ${total} differ\n`);
}

test("the tricky table reads the same in Rust and TypeScript", () => {
  check("tricky", (add) => {
    for (const [, source, options, hidden] of TRICKY) add(compare(source, options, hidden));
  });
});

test("the tests' own texts read the same under every option set", () => {
  check("literals", (add) => {
    for (const source of TEST_LITERALS) {
      CONFIGS.forEach((options, i) => add(compare(source, options, HIDDEN[i % HIDDEN.length]!)));
    }
  });
});

test("every tricky text reads the same under every option set", () => {
  check("tricky x options", (add) => {
    for (const [, source] of TRICKY) {
      CONFIGS.forEach((options, i) => add(compare(source, options, HIDDEN[i % HIDDEN.length]!)));
    }
  });
});

test("generated texts read the same: short, and long with many pieces", () => {
  check("generated", (add) => {
    generated(2500, 12, 7).forEach((source, k) => {
      add(compare(source, CONFIGS[k % CONFIGS.length]!, HIDDEN[k % HIDDEN.length]!));
      add(compare(source, CONFIGS[(k * 3 + 1) % CONFIGS.length]!, HIDDEN[(k + 2) % HIDDEN.length]!));
    });
    generated(800, 60, 99).forEach((source, k) => add(compare(source, CONFIGS[k % CONFIGS.length]!, HIDDEN[(k + 2) % HIDDEN.length]!)));
  });
});

test("empty, very long and unusual inputs read the same", () => {
  check("edges", (add) => {
    const long = `${"x".repeat(2000)} \`a/b.md\` @Bob [l](out/a.md) ${"中文😀 ".repeat(300)}`.repeat(40);
    for (const source of ["", "\n", "\u0000", "@", "`", "[", "](", long, long + "\n```\nunclosed"]) {
      CONFIGS.forEach((options, i) => add(compare(source, options, HIDDEN[i % HIDDEN.length]!)));
    }
  });
});

/** A message of about `chars` characters, as a Bot writes one: prose, a path, a code span, a link, a mention. */
function message(chars: number): string {
  const unit = "Done: I changed `src/app.ts` and wrote report.md; see [the plan](out/plan.md) and ask @Bob about it.\n\n- one item with `code`\n- 中文说明和 emoji 😀\n\n";
  let out = "";
  while (out.length < chars) out += unit;
  return out.slice(0, chars);
}

test("benchmark: Rust against TypeScript in this engine (informational)", () => {
  const options: RenderMarkdownOptions = { extraPaths: ["src/app.ts", "report.md"], mentionBots: bots, mentionMembers: members };
  const rows: string[] = [];
  for (const [chars, runs] of [[385, 200], [1540, 100], [4620, 50]] as const) {
    const source = message(chars);
    expect(native(source, options, [])).toBe(prepareMarkdownJs(source, options, []));
    const time = (run: () => string) => {
      run();
      const started = Date.now();
      for (let i = 0; i < runs; i++) run();
      return (Date.now() - started) / runs;
    };
    const js = time(() => prepareMarkdownJs(source, options, []));
    const rust = time(() => native(source, options, []));
    rows.push(`${source.length} chars: TypeScript ${js.toFixed(3)} ms, Rust ${rust.toFixed(3)} ms (${(js / Math.max(rust, 0.0001)).toFixed(1)}x)`);
  }
  console.log(`prepareMarkdown benchmark\n${rows.join("\n")}`);
});
