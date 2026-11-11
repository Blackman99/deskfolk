//! The top-level blocks of a Markdown file and the source lines each was written on, for the
//! annotator's preview (`ui/annotations/markdown-blocks.ts`). The JavaScript lexer it used
//! (`marked`) is superlinear in QuickJS: 20 000 characters took 83 ms, 60 000 over two seconds, and
//! a 480 000-character report held the window for 44 s. `markdown-rs`, the parser `TextView`
//! renders with, reads that file in milliseconds, and the module runs it off the engine thread.

use markdown::{Constructs, ParseOptions};

/// The parse `TextView` makes (GFM), with front matter as a block of its own, as the messenger's
/// `splitFrontMatter` makes it.
fn options() -> ParseOptions {
    ParseOptions { constructs: Constructs { frontmatter: true, ..Constructs::gfm() }, ..ParseOptions::gfm() }
}

/// Each top-level block's first and last source line, 1-based and both included, in order. A loose
/// list's end can fall on the blank line after it; the block ends on its last written line.
pub fn block_lines(source: &str) -> Vec<(usize, usize)> {
    let Ok(tree) = markdown::to_mdast(source, &options()) else { return Vec::new() };
    let Some(children) = tree.children() else { return Vec::new() };
    let lines: Vec<&str> = source.split('\n').collect();
    let blank = |line: usize| lines.get(line - 1).is_none_or(|text| text.trim().is_empty());
    children
        .iter()
        .filter_map(|node| node.position())
        .map(|at| {
            let start = at.start.line;
            let mut end = at.end.line.max(start);
            while end > start && blank(end) {
                end -= 1;
            }
            (start, end)
        })
        .collect()
}

/// `block_lines` as the JSON the module hands back: `[[start, end], …]`.
pub fn block_lines_json(source: &str) -> String {
    let lines = block_lines(source);
    let mut out = String::with_capacity(lines.len() * 12 + 2);
    out.push('[');
    for (i, (start, end)) in lines.iter().enumerate() {
        if i > 0 {
            out.push(',');
        }
        out.push_str(&format!("[{start},{end}]"));
    }
    out.push(']');
    out
}
