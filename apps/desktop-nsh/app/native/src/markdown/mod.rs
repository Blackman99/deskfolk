//! `prepareMarkdown` in Rust: the source of a chat bubble as `TextView` reads it, with workspace
//! paths and roster names linked and those links turned into `<artifact>` and `<mention>`
//! elements. It is the port of `app/src/ui/markdown.ts` (kept there as `prepareMarkdownJs`, the
//! fallback and the reference the parity test compares against), of `linkifyWorkspacePaths` and
//! `parseArtifactHref` (`apps/messenger/src/lib/overlays/artifacts.ts`), of `linkifyRosterMentions`
//! and `parseMentions` (`mention-chips.ts`, `packages/protocol/src/mentions.ts`) and of
//! `looksLikeWorkspacePath` (`cited-path.ts`).
//!
//! It runs on every bubble render and every streamed token, and the app's JavaScript is QuickJS,
//! 8 to 30 times slower than a browser's engine at the regexes this is made of. The output is the
//! same string, byte for byte, which is why each regex is written out here as the scan it is, with
//! JavaScript's own idea of white space, digits and `.` (`js.rs`) rather than Rust's.
//!
//! Pure Rust, so it builds for the web's wasm32 as it does for the desktops.

mod js;
mod links;
mod mentions;
mod paths;
#[cfg(test)]
mod tests;

use std::collections::HashSet;

use nsh_core::prelude::*;
use serde_json::Value;

use js::{is_line_terminator, replace_placeholders, trim};
use links::{Label, Link, link_at, next_link};
use mentions::{Mentionable, linkify_roster_mentions, parse_mention_href};
use paths::{Kept, looks_like_workspace_href, parse_artifact_href};

/// Where a link goes: a Bot, a file of the workspace, or anywhere else.
enum Target {
    Mention(String),
    Artifact(String),
    Url,
}

fn link_target(href: &str) -> Target {
    let mut raw = trim(href);
    raw = raw.strip_prefix('<').unwrap_or(raw);
    raw = raw.strip_suffix('>').unwrap_or(raw);
    if let Some(bot) = parse_mention_href(raw) {
        return Target::Mention(bot);
    }
    if let Some(artifact) = parse_artifact_href(raw) {
        return Target::Artifact(artifact);
    }
    if looks_like_workspace_href(raw) {
        return Target::Artifact(raw.to_string());
    }
    Target::Url
}

/// The source split into fenced code (left alone) and the rest: a fence opens on a line that
/// starts with up to three spaces and three backticks or tildes, and closes on a line of nothing
/// but at least as many of the same. One never closed runs to the end.
fn split_fences(source: &str) -> Vec<(&str, bool)> {
    let mut parts = Vec::new();
    let mut open: Option<&str> = None;
    let (mut start, mut at) = (0, 0);
    for line in source.split_inclusive('\n') {
        let run = fence_run(line);
        let end = at + line.len();
        match open {
            None => {
                if let Some(run) = run {
                    if at > start {
                        parts.push((&source[start..at], false));
                    }
                    start = at;
                    open = Some(run);
                }
            }
            Some(opening) => {
                if let Some(run) = run
                    && run.as_bytes()[0] == opening.as_bytes()[0]
                    && run.len() >= opening.len()
                    && trim(line) == run
                {
                    parts.push((&source[start..end], true));
                    start = end;
                    open = None;
                }
            }
        }
        at = end;
    }
    if at > start {
        parts.push((&source[start..at], open.is_some()));
    }
    parts
}

/// `^ {0,3}(`{3,}|~{3,})`: the run of fence characters a line starts with.
fn fence_run(line: &str) -> Option<&str> {
    let rest = line.trim_start_matches(' ');
    if line.len() - rest.len() > 3 {
        return None;
    }
    let c = *rest.as_bytes().first()?;
    if c != b'`' && c != b'~' {
        return None;
    }
    let n = rest.bytes().take_while(|&b| b == c).count();
    (n >= 3).then(|| &rest[..n])
}

fn attr(v: &str) -> String {
    v.replace('&', "&amp;").replace('"', "&quot;").replace('<', "&lt;")
}

fn text(v: &str) -> String {
    v.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;")
}

/// `v.replace(/\\(.)/g, "$1")`: a backslash and the character after it become that character,
/// unless it is a line end.
fn unescape_label(v: &str) -> String {
    let mut out = String::with_capacity(v.len());
    let mut chars = v.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '\\'
            && let Some(&n) = chars.peek()
            && !is_line_terminator(n)
        {
            out.push(n);
            chars.next();
        } else {
            out.push(c);
        }
    }
    out
}

/// A line that is only a link: `^\s*(?<!!)\[…\]\(…\)\s*$`. (The lookbehind always holds there:
/// what stands before the `[` is white space or the line's start.)
fn standalone_link(line: &str) -> Option<Link> {
    let at = line.find(|c: char| !js::is_space(c)).unwrap_or(line.len());
    if line.as_bytes().get(at) != Some(&b'[') {
        return None;
    }
    link_at(line, at, Label::Escaped, |end| line[end..].chars().all(js::is_space))
}

fn chips_in(part: &str, hidden: &HashSet<String>) -> String {
    // Code spans are set aside whole: `(`+)[^`\n][\s\S]*?\1`, a run of backticks, a character, and
    // the first run of at least as many that follows.
    let mut kept = Kept(Vec::new());
    let b = part.as_bytes();
    let mut guarded = String::with_capacity(part.len());
    let (mut last, mut p) = (0, 0);
    while p < b.len() {
        if b[p] != b'`' {
            p += 1;
            continue;
        }
        let k = b[p..].iter().take_while(|&&c| c == b'`').count();
        let after = p + k;
        // The character after the run is not a backtick, and has to be something but a newline.
        let c = part[after..].chars().next();
        if let Some(c) = c
            && c != '\n'
            && let Some(close) = find_ticks(part, after + c.len_utf8(), k)
        {
            guarded.push_str(&part[last..p]);
            guarded.push_str(&kept.keep('C', &part[p..close + k]));
            last = close + k;
            p = close + k;
        } else {
            p += 1;
        }
    }
    guarded.push_str(&part[last..]);

    let lines_kept: String;
    let body: &str = if hidden.is_empty() {
        &guarded
    } else {
        lines_kept = guarded
            .split_inclusive('\n')
            .filter(|line| {
                let Some(link) = standalone_link(line) else { return true };
                let label = &line[link.label.0..link.label.1];
                match link_target(&line[link.target.0..link.target.1]) {
                    Target::Artifact(path) => !(hidden.contains(&path) && trim(&unescape_label(label)) == path),
                    _ => true,
                }
            })
            .collect();
        &lines_kept
    };

    let mut chipped = String::with_capacity(body.len());
    let mut from = 0;
    while let Some(link) = next_link(body, from, Label::Escaped) {
        chipped.push_str(&body[from..link.start]);
        let name = unescape_label(&body[link.label.0..link.label.1]);
        match link_target(&body[link.target.0..link.target.1]) {
            Target::Mention(id) => chipped.push_str(&format!("<mention id=\"{}\">{}</mention>", attr(&id), text(&name))),
            Target::Artifact(path) => chipped.push_str(&format!("<artifact path=\"{}\">{}</artifact>", attr(&path), text(&name))),
            Target::Url => chipped.push_str(&body[link.start..link.end]),
        }
        from = link.end;
    }
    chipped.push_str(&body[from..]);
    replace_placeholders(&chipped, b'C', |digits| js::kept_at(&kept.0, digits).to_string())
}

/// The first run of `k` backticks that starts at or after `from`.
fn find_ticks(s: &str, from: usize, k: usize) -> Option<usize> {
    let b = s.as_bytes();
    let mut p = from;
    while let Some(i) = s[p..].find('`') {
        p += i;
        let run = b[p..].iter().take_while(|&&c| c == b'`').count();
        if run >= k {
            return Some(p);
        }
        p += run;
    }
    None
}

fn mentionables(options: &Value, key: &str) -> Vec<Mentionable> {
    let Some(list) = options.get(key).and_then(Value::as_array) else { return Vec::new() };
    list.iter()
        .filter_map(|item| Some(Mentionable { id: item.get("id")?.as_str()?.to_string(), name: item.get("name")?.as_str()?.to_string() }))
        .collect()
}

/// The source as `MarkdownBody` hands it to `TextView`: paths and roster names linked as the
/// messenger links them, those links as chip elements, and the standalone lines that only repeat a
/// file shown elsewhere (`hidden`) dropped. `options` is the TSX's `RenderMarkdownOptions` as JSON;
/// only `extraPaths`, `mentionBots` and `mentionMembers` take part.
pub fn prepare(source: &str, options: &str, hidden: &[String]) -> String {
    if source.is_empty() {
        return String::new();
    }
    let options: Value = serde_json::from_str(options).unwrap_or(Value::Null);
    let extra_paths: Vec<String> = options.get("extraPaths").and_then(Value::as_array).map(|a| a.iter().filter_map(|v| v.as_str().map(str::to_string)).collect()).unwrap_or_default();
    let linked = paths::linkify_workspace_paths(source, &extra_paths);
    let mentioned = linkify_roster_mentions(&linked, &mentionables(&options, "mentionBots"), &mentionables(&options, "mentionMembers"));
    let hidden: HashSet<String> = hidden.iter().cloned().collect();
    split_fences(&mentioned).into_iter().map(|(part, fence)| if fence { part.to_string() } else { chips_in(part, &hidden) }).collect()
}

/// Markdown for `TextView`, prepared natively.
#[module]
pub struct Markdown;

#[module]
impl Markdown {
    /// `prepareMarkdown(source, options, hidden)`: `options` as JSON, `hidden` the file paths whose
    /// standalone link lines are dropped.
    pub fn prepare_markdown(source: String, options: String, hidden: Vec<String>) -> String {
        prepare(&source, &options, &hidden)
    }
}
