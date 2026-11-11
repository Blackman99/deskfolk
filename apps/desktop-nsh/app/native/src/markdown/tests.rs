//! The port against the JavaScript it replaces. `CASES` is what `prepareMarkdownJs` answered for
//! the tricky inputs, written down; `app/src/ui/markdown-native.test.ts` runs a much larger corpus
//! through both, live, in the app's own engine.

use super::js;
use super::*;

// Generated once from the JavaScript this replaces (`prepareMarkdownJs`, run in Bun), kept as a table of what it answered.
#[rustfmt::skip]
const CASES: &[(&str, &str, &str, &[&str], &str)] = &[
    ("empty source with extra paths", "", "{\"extraPaths\":[\"a.md\"]}", &[], ""),
    ("a bare path, a code span that is a path, one that is a command", "Open src/app.ts, `README.md` and `cat src/app.ts`.", "{\"extraPaths\":[\"src/app.ts\"]}", &[], "Open <artifact path=\"src/app.ts\">src/app.ts</artifact>, <artifact path=\"README.md\">README.md</artifact> and `cat src/app.ts`."),
    ("a path glued to word characters is not linked, one next to CJK is", "xsrc/app.ts src/app.ts.bak 看src/app.ts了 src/app.ts。", "{\"extraPaths\":[\"src/app.ts\"]}", &[], "xsrc/app.ts src/app.ts.bak 看<artifact path=\"src/app.ts\">src/app.ts</artifact>了 <artifact path=\"src/app.ts\">src/app.ts</artifact>。"),
    ("longer known paths win, spaces go in angle brackets", "out/my file.md and out/my file.md.bak and out/a.md", "{\"extraPaths\":[\"out/a.md\",\"out/my file.md\"]}", &[], "<artifact path=\"out/my file.md\">out/my file.md</artifact> and out/my file.md.bak and <artifact path=\"out/a.md\">out/a.md</artifact>"),
    ("fenced code is left alone, and so is an unclosed fence's rest", "see a/b.md\n```\na/b.md @Bob\n```\nthen ~~~\nc/d.md\n", "{\"mentionBots\":[{\"id\":\"b1\",\"name\":\"Bob\"},{\"id\":\"b2\",\"name\":\"分镜师\"},{\"id\":\"b 3\",\"name\":\"3D师\"},{\"id\":\"b4\",\"name\":\"İstanbul\"}],\"mentionMembers\":[{\"id\":\"m1\",\"name\":\"审稿员\"},{\"id\":\"m2\",\"name\":\"Ada\"},{\"id\":\"m3\",\"name\":\"Adam\"}]}", &[], "see a/b.md\n```\na/b.md @Bob\n```\nthen ~~~\nc/d.md\n"),
    ("a fence closed only by at least as many marks", "````\n```\nx/y.md\n````\nz/w.md\n", "{\"extraPaths\":[]}", &[], "````\n```\nx/y.md\n````\nz/w.md\n"),
    ("tildes do not close backticks, an indented closing fence does", "```\nq/r.md\n~~~\n   ```\n@Bob q/r.md", "{\"mentionBots\":[{\"id\":\"b1\",\"name\":\"Bob\"},{\"id\":\"b2\",\"name\":\"分镜师\"},{\"id\":\"b 3\",\"name\":\"3D师\"},{\"id\":\"b4\",\"name\":\"İstanbul\"}],\"mentionMembers\":[{\"id\":\"m1\",\"name\":\"审稿员\"},{\"id\":\"m2\",\"name\":\"Ada\"},{\"id\":\"m3\",\"name\":\"Adam\"}]}", &[], "```\nq/r.md\n~~~\n   ```\n<mention id=\"b1\">@Bob</mention> q/r.md"),
    ("code spans of several backticks", "`` a ` b/c.md `` and ``x`` and `unclosed b/c.md and ```y``` b/d.md", "{\"extraPaths\":[]}", &[], "`` a ` b/c.md `` and ``x`` and `unclosed b/c.md and ```y``` b/d.md"),
    ("a link with escaped brackets and a link with an angle href", "[a\\]b\\[c](out/x.md) and [name](<out/my file.md>) and [x](<>)", "{\"extraPaths\":[]}", &[], "<artifact path=\"out/x.md\">a]b[c</artifact> and <artifact path=\"out/my file.md\">name</artifact> and [x](<>)"),
    ("images are not chips, the link inside a bang-bracket is", "![img](out/a.png) and ![[w](out/w.md)", "{\"extraPaths\":[]}", &[], "![img](out/a.png) and ![<artifact path=\"out/w.md\">w</artifact>"),
    ("a link whose label has a backslash before a newline does not parse", "[a\\\nb](out/x.md) [c\\d](out/y.md)", "{\"extraPaths\":[]}", &[], "[a\\\nb](out/x.md) <artifact path=\"out/y.md\">cd</artifact>"),
    ("a link across lines", "[a\nb](out/x.md)", "{\"extraPaths\":[]}", &[], "<artifact path=\"out/x.md\">a\nb</artifact>"),
    ("urls and anchors stay links", "[a](https://x.com/a.md) [b](#top) [c](?q=1.md) [d](mailto:a@b.md)", "{\"extraPaths\":[]}", &[], "[a](https://x.com/a.md) [b](#top) [c](?q=1.md) [d](mailto:a@b.md)"),
    ("artifact hrefs, percent-encoded twice, and a broken escape", "[a](artifact:out%2Fa.md) [b](artifact:%25E4%25BD%25A0.md) [c](artifact:%zz.md) [d](artifact:)", "{\"extraPaths\":[]}", &[], "<artifact path=\"out/a.md\">a</artifact> <artifact path=\"你.md\">b</artifact> <artifact path=\"%zz.md\">c</artifact> [d](artifact:)"),
    ("windows paths and backslash-relative ones", "C:\\Users\\me\\a.txt src\\foo.ts and `.\\notes\\a.md` and `a \\ b`", "{\"extraPaths\":[\"C:\\\\Users\\\\me\\\\a.txt\",\"src\\\\foo.ts\"]}", &[], "<artifact path=\"C:\\Users\\me\\a.txt\">C:Usersmea.txt</artifact> <artifact path=\"src\\foo.ts\">srcfoo.ts</artifact> and <artifact path=\".\\notes\\a.md\">.notesa.md</artifact> and `a \\ b`"),
    ("host absolute paths in code spans", "`/Users/me/site/index.html` `/sidebar` `/tmp/out/` `~/n.md` `//x/y`", "{\"extraPaths\":[]}", &[], "<artifact path=\"/Users/me/site/index.html\">/Users/me/site/index.html</artifact> `/sidebar` <artifact path=\"/tmp/out/\">/tmp/out/</artifact> <artifact path=\"~/n.md\">~/n.md</artifact> `//x/y`"),
    ("roster mentions resolved by name, longest first", "@Bob hi, @分镜师请出图，@3D师 and @everyone", "{\"mentionBots\":[{\"id\":\"b1\",\"name\":\"Bob\"},{\"id\":\"b2\",\"name\":\"分镜师\"},{\"id\":\"b 3\",\"name\":\"3D师\"},{\"id\":\"b4\",\"name\":\"İstanbul\"}],\"mentionMembers\":[{\"id\":\"m1\",\"name\":\"审稿员\"},{\"id\":\"m2\",\"name\":\"Ada\"},{\"id\":\"m3\",\"name\":\"Adam\"}]}", &[], "<mention id=\"b1\">@Bob</mention> hi, <mention id=\"b2\">@分镜师</mention>请出图，<mention id=\"b 3\">@3D师</mention> and <mention id=\"everyone\">@everyone</mention>"),
    ("mentions of a member and of a misspelt name", "@审稿 @Ad @Adam @Ada @分镜 @分 @İstan @istan", "{\"mentionBots\":[{\"id\":\"b1\",\"name\":\"Bob\"},{\"id\":\"b2\",\"name\":\"分镜师\"},{\"id\":\"b 3\",\"name\":\"3D师\"},{\"id\":\"b4\",\"name\":\"İstanbul\"}],\"mentionMembers\":[{\"id\":\"m1\",\"name\":\"审稿员\"},{\"id\":\"m2\",\"name\":\"Ada\"},{\"id\":\"m3\",\"name\":\"Adam\"}]}", &[], "<mention id=\"m1\">@审稿员</mention> <mention id=\"unresolved:Ad\">@Ad</mention> <mention id=\"m3\">@Adam</mention> <mention id=\"unresolved:Ada\">@Ada</mention> <mention id=\"unresolved:分镜\">@分镜</mention> <mention id=\"unresolved:分\">@分</mention> <mention id=\"unresolved:İstan\">@İstan</mention> <mention id=\"unresolved:istan\">@istan</mention>"),
    ("unresolved tokens, digits, glued @, joined @A/@B", "@Nobody user@host.com @14:30 @37.79s a/@Bob @Bob/@分镜师 @scope/pkg [@x](p.md)", "{\"mentionBots\":[{\"id\":\"b1\",\"name\":\"Bob\"},{\"id\":\"b2\",\"name\":\"分镜师\"},{\"id\":\"b 3\",\"name\":\"3D师\"},{\"id\":\"b4\",\"name\":\"İstanbul\"}],\"mentionMembers\":[{\"id\":\"m1\",\"name\":\"审稿员\"},{\"id\":\"m2\",\"name\":\"Ada\"},{\"id\":\"m3\",\"name\":\"Adam\"}]}", &[], "<mention id=\"unresolved:Nobody\">@Nobody</mention> user@host.com @14:30 @37.79s a/@Bob <mention id=\"b1\">@Bob</mention>/<mention id=\"b2\">@分镜师</mention> @scope/pkg <artifact path=\"p.md\">@x</artifact>"),
    ("a mention inside code and inside a link target", "`@Bob` [@Bob](x/@Bob.md) (@Bob) @Bob.", "{\"mentionBots\":[{\"id\":\"b1\",\"name\":\"Bob\"},{\"id\":\"b2\",\"name\":\"分镜师\"},{\"id\":\"b 3\",\"name\":\"3D师\"},{\"id\":\"b4\",\"name\":\"İstanbul\"}],\"mentionMembers\":[{\"id\":\"m1\",\"name\":\"审稿员\"},{\"id\":\"m2\",\"name\":\"Ada\"},{\"id\":\"m3\",\"name\":\"Adam\"}]}", &[], "`@Bob` <artifact path=\"x/@Bob.md\">@Bob</artifact> (<mention id=\"b1\">@Bob</mention>) <mention id=\"b1\">@Bob</mention>."),
    ("mentions without bots are left, even with members", "@Ada @Bob", "{\"mentionMembers\":[{\"id\":\"m1\",\"name\":\"审稿员\"},{\"id\":\"m2\",\"name\":\"Ada\"},{\"id\":\"m3\",\"name\":\"Adam\"}]}", &[], "@Ada @Bob"),
    ("a bot with brackets and slash in its name and id", "@x[y] @A\\B", "{\"mentionBots\":[{\"id\":\"a/b é\",\"name\":\"x[y]\"},{\"id\":\"i2\",\"name\":\"A\\\\B\"}]}", &[], "<mention id=\"a/b é\">@xy</mention> <mention id=\"i2\">@AB</mention>"),
    ("standalone link lines of hidden files are dropped", "intro\n[out/a.md](out/a.md)\n  [out/b.md](out/b.md)  \n[other](out/a.md)\n![i](out/a.md)\nend [out/a.md](out/a.md)\n", "{\"extraPaths\":[]}", &["out/a.md"], "intro\n  <artifact path=\"out/b.md\">out/b.md</artifact>  \n<artifact path=\"out/a.md\">other</artifact>\n![i](out/a.md)\nend <artifact path=\"out/a.md\">out/a.md</artifact>\n"),
    ("hidden with an escaped label and an angle path", "[out/my\\ file.md](<out/my file.md>)\nkept", "{\"extraPaths\":[]}", &["out/my file.md"], "kept"),
    ("hidden line inside a code span stays", "`\n[out/a.md](out/a.md)\n`\n[out/a.md](out/a.md)", "{\"extraPaths\":[]}", &["out/a.md"], "`\n`\n"),
    ("placeholders written in the source are replaced like the JavaScript does", "x \u{0000}C0\u{0000} y `a` \u{0000}C1\u{0000} \u{0000}L0\u{0000} \u{0000}C99999999999999999999\u{0000} \u{0000}M0\u{0000}", "{\"mentionBots\":[{\"id\":\"b1\",\"name\":\"Bob\"},{\"id\":\"b2\",\"name\":\"分镜师\"},{\"id\":\"b 3\",\"name\":\"3D师\"},{\"id\":\"b4\",\"name\":\"İstanbul\"}],\"mentionMembers\":[{\"id\":\"m1\",\"name\":\"审稿员\"},{\"id\":\"m2\",\"name\":\"Ada\"},{\"id\":\"m3\",\"name\":\"Adam\"}]}", &[], "x `a` y `a` `a` `a`  `a`"),
    ("the placeholder test: a path named L0", "L0 `b/c.md` L0", "{\"extraPaths\":[\"L0\"]}", &[], "[L0](L0) \u{0000}[L0](L0)\u{0000} [L0](L0)"),
    ("white space the JavaScript knows and Rust does not", "[a](x.md)﻿\n﻿[b](out/a.md) \n  [c](out/a.md)　", "{\"extraPaths\":[]}", &["out/a.md"], "<artifact path=\"x.md\">a</artifact>﻿\n﻿<artifact path=\"out/a.md\">b</artifact> \n  <artifact path=\"out/a.md\">c</artifact>　"),
    ("CJK, emoji and astral characters around chips", "😀 `文档/报告.md` 😀@Bob😀 [名字](文档/报告.md)。@分镜师😀", "{\"mentionBots\":[{\"id\":\"b1\",\"name\":\"Bob\"},{\"id\":\"b2\",\"name\":\"分镜师\"},{\"id\":\"b 3\",\"name\":\"3D师\"},{\"id\":\"b4\",\"name\":\"İstanbul\"}],\"mentionMembers\":[{\"id\":\"m1\",\"name\":\"审稿员\"},{\"id\":\"m2\",\"name\":\"Ada\"},{\"id\":\"m3\",\"name\":\"Adam\"}]}", &[], "😀 <artifact path=\"文档/报告.md\">文档/报告.md</artifact> 😀<mention id=\"b1\">@Bob</mention>😀 <artifact path=\"文档/报告.md\">名字</artifact>。<mention id=\"b2\">@分镜师</mention>😀"),
    ("entities in chip names and paths", "[a & <b> \"c\"](out/a&b.md) @Bob", "{\"mentionBots\":[{\"id\":\"b1\",\"name\":\"Bob\"},{\"id\":\"b2\",\"name\":\"分镜师\"},{\"id\":\"b 3\",\"name\":\"3D师\"},{\"id\":\"b4\",\"name\":\"İstanbul\"}],\"mentionMembers\":[{\"id\":\"m1\",\"name\":\"审稿员\"},{\"id\":\"m2\",\"name\":\"Ada\"},{\"id\":\"m3\",\"name\":\"Adam\"}]}", &[], "<artifact path=\"out/a&amp;b.md\">a &amp; &lt;b&gt; \"c\"</artifact> <mention id=\"b1\">@Bob</mention>"),
    ("bot: hrefs, decoded and broken", "[a](bot:b1) [b](bot:%E4%BD%A0) [c](bot:%zz) [d](bot:) [e](<bot:x y>)", "{\"extraPaths\":[]}", &[], "<mention id=\"b1\">a</mention> <mention id=\"你\">b</mention> [c](bot:%zz) [d](bot:) <mention id=\"x y\">e</mention>"),
    ("crlf lines", "a\r\n```\r\nb/c.md\r\n```\r\n[out/a.md](out/a.md)\r\n", "{\"extraPaths\":[]}", &["out/a.md"], "a\r\n```\r\nb/c.md\r\n```\r\n"),
    ("a code span with a newline is not one", "`a\nb/c.md`", "{\"extraPaths\":[]}", &[], "`a\nb/c.md`"),
    ("extra paths: blanks, repeats, padded", "a.md b.md", "{\"extraPaths\":[\"\",\" a.md \",\"a.md\",\"  \",\"b.md\"]}", &[], "<artifact path=\"a.md\">a.md</artifact> <artifact path=\"b.md\">b.md</artifact>"),
];

#[test]
fn prepare_matches_what_the_javascript_answered() {
    for (name, source, options, hidden, want) in CASES {
        let hidden: Vec<String> = hidden.iter().map(|s| s.to_string()).collect();
        assert_eq!(prepare(source, options, &hidden), *want, "{name}");
    }
}

#[test]
fn options_that_are_not_json_read_as_none() {
    assert_eq!(prepare("a b.md `x/y.md`", "not json", &[]), "a b.md <artifact path=\"x/y.md\">x/y.md</artifact>");
}

#[test]
fn js_white_space_is_not_rusts() {
    assert!(js::is_space('\u{feff}') && js::is_space('\u{a0}') && js::is_space('\u{2028}'));
    assert!(!js::is_space('\u{85}') && !js::is_space('\u{200b}') && !js::is_space('\u{180e}'));
    assert_eq!(js::trim("\u{feff} a b\u{3000}\n"), "a b");
}

#[test]
fn uri_components_decode_and_encode_as_the_javascript_does() {
    assert_eq!(js::decode_uri_component("a%20b%E4%BD%A0%2F"), Some("a b你/".to_string()));
    assert_eq!(js::decode_uri_component("%F0%9F%98%80"), Some("😀".to_string()));
    for bad in ["%", "%4", "%zz", "%C0%80", "%ED%A0%80", "%E4%BD", "%80", "%F8%80%80%80%80", "%F4%90%80%80", "%E4%BD%41"] {
        assert_eq!(js::decode_uri_component(bad), None, "{bad}");
    }
    assert_eq!(js::encode_uri_component("a b/ü!~*'()-_.é😀"), "a%20b%2F%C3%BC!~*'()-_.%C3%A9%F0%9F%98%80");
}

#[test]
fn fences_open_on_lines_and_close_on_at_least_as_many_marks() {
    assert_eq!(split_fences("a\n```\nb\n```\nc"), vec![("a\n", false), ("```\nb\n```\n", true), ("c", false)]);
    assert_eq!(split_fences("```\nb\n~~~\n``\n"), vec![("```\nb\n~~~\n``\n", true)]);
    assert_eq!(split_fences("    ```\nx"), vec![("    ```\nx", false)]);
    assert_eq!(split_fences(""), Vec::<(&str, bool)>::new());
}

#[test]
fn lazy_fences_match_anywhere_and_an_unclosed_one_is_prose() {
    use paths::split_fences_lazy;
    assert_eq!(split_fences_lazy("a ```b``` c ~~~d"), vec![("a ", false), ("```b```", true), (" c ~~~d", false)]);
    assert_eq!(split_fences_lazy("````x"), vec![("````x", false)]);
    assert_eq!(split_fences_lazy(""), vec![("", false)]);
}

#[test]
fn a_long_text_of_everything_stays_linear_enough() {
    let source = "x `a/b.md` @Bob [l](out/a.md) ```\n".repeat(3000);
    let options = "{\"mentionBots\":[{\"id\":\"b\",\"name\":\"Bob\"}]}";
    let started = std::time::Instant::now();
    let out = prepare(&source, options, &[]);
    assert!(out.contains("<mention id=\"b\">@Bob</mention>"));
    assert!(started.elapsed().as_secs() < 10);
}
