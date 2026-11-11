//! Workspace paths in chat text: `looksLikeWorkspacePath` (`packages/protocol/src/cited-path.ts`)
//! and `linkifyWorkspacePaths` with the artifact hrefs (`apps/messenger/src/lib/overlays/artifacts.ts`).

use std::collections::HashSet;

use super::js::{self, has_space, is_space, is_word_byte, kept_at, replace_placeholders, trim};
use super::links::{Label, next_link};

/// Filename suffixes that make a bare `report.md` look like a path.
const EXTENSIONS: &[&str] = &[
    "png", "jpg", "jpeg", "gif", "webp", "bmp", "ico", "svg", "mp3", "wav", "m4a", "aac", "ogg", "flac", "opus", "mp4", "webm", "mov", "m4v", "pdf", "html", "htm", "md", "markdown", "txt", "csv", "tsv", "log", "js", "mjs", "cjs", "ts", "tsx", "jsx", "svelte", "vue", "py", "pyi", "rs", "go", "java", "kt", "kts", "c", "h", "cc", "cpp", "cxx", "hpp", "hh", "cs", "php", "rb", "swift", "dart", "scala", "lua", "r", "pl", "pm", "hs", "ex", "exs", "erl", "hrl", "clj", "cljs", "zig", "nim", "json", "jsonc", "json5", "jsonl", "yaml", "yml", "toml", "xml", "css", "scss", "less", "sql", "graphql", "gql", "proto", "sh", "bash", "zsh", "fish", "ps1", "psm1", "bat", "cmd", "diff", "patch", "ini", "cfg", "conf", "env", "properties", "tf", "tfvars", "hcl", "mk", "docx", "xlsx", "pptx", "doc", "xls", "ppt", "psd", "ai", "sketch", "fig", "xd", "zip", "tar", "gz", "tgz", "7z", "glb", "gltf", "obj", "ttf", "otf", "woff", "woff2", "sqlite", "db",
];

const ARTIFACT_SCHEME: &str = "artifact:";

fn is_sep(c: char) -> bool {
    c == '\\' || c == '/'
}

/// The text after the last `\` or `/`.
fn base_name(path: &str) -> &str {
    path.rsplit(is_sep).next().unwrap_or(path)
}

fn extension_of(name: &str) -> String {
    let base = base_name(name);
    match base.rfind('.') {
        Some(dot) if dot > 0 => base[dot + 1..].to_lowercase(),
        _ => String::new(),
    }
}

/// `^(?:[A-Za-z]:[\\/]|\\\\[^\\/\s]+[\\/][^\\/\s]+)`: `C:\x`, `C:/x`, `\\server\share\x`.
fn windows_absolute(path: &str) -> bool {
    let b = path.as_bytes();
    if b.len() >= 3 && b[0].is_ascii_alphabetic() && b[1] == b':' && (b[2] == b'\\' || b[2] == b'/') {
        return true;
    }
    let Some(rest) = path.strip_prefix("\\\\") else { return false };
    let name = |c: char| !is_sep(c) && !is_space(c);
    let first = rest.find(|c: char| !name(c)).unwrap_or(rest.len());
    if first == 0 || !rest[first..].starts_with(is_sep) {
        return false;
    }
    rest[first + 1..].chars().next().is_some_and(name)
}

fn host_absolute(path: &str) -> bool {
    path.starts_with('/') || windows_absolute(path)
}

/// `src\foo.ts`: a relative path written with Windows separators, each name a real one.
fn is_backslash_relative(path: &str) -> bool {
    if !path.contains('\\') || path.starts_with(is_sep) || path.contains([':', '*', '?', '"', '<', '>', '|', '\t', '\r', '\n']) {
        return false;
    }
    let mut names: Vec<&str> = path.split(is_sep).collect();
    if names.last() == Some(&"") {
        names.pop();
    }
    names.iter().all(|n| !n.is_empty() && trim(n) == *n)
}

/// The path as written, without the `<…>` around one that has spaces.
fn cited_as_written(raw: &str) -> &str {
    let path = trim(raw);
    if path.len() >= 2 && path.starts_with('<') && path.ends_with('>') { trim(&path[1..path.len() - 1]) } else { path }
}

fn normalize_cited_path(raw: &str) -> Option<String> {
    let mut path = cited_as_written(raw).to_string();
    if !host_absolute(&path) && is_backslash_relative(&path) {
        path = path.replace('\\', "/");
    }
    if let Some(rest) = path.strip_prefix("./") {
        path = rest.to_string();
    }
    if path.is_empty() {
        return None;
    }
    Some(path)
}

fn has_scheme(path: &str) -> bool {
    let lower = |n: usize| path.get(..n).map(str::to_ascii_lowercase);
    ["https:", "http:", "mailto:", "javascript:", "data:", "artifact:", "bot:"].iter().any(|p| lower(p.len()).as_deref() == Some(*p)) || path.contains("://")
}

/// `/Users/me/site/index.html`: two names at least, and no pattern characters.
fn looks_like_posix_absolute(path: &str) -> bool {
    if path.starts_with("//") || path.contains(['\\', '{', '}', '<', '>', '*', '?', '|']) || has_space(path) {
        return false;
    }
    path.split('/').filter(|s| !s.is_empty()).count() >= 2
}

/// Whether `raw` is a relative workspace path (a slash, or a known suffix) or a host absolute one.
pub(crate) fn looks_like_workspace_path(raw: &str) -> bool {
    let Some(path) = normalize_cited_path(raw) else { return false };
    if has_scheme(&path) || path.starts_with('@') {
        return false;
    }
    if windows_absolute(&path) {
        return true;
    }
    if path.starts_with('/') {
        return looks_like_posix_absolute(&path);
    }
    let ext = extension_of(&path);
    let known = !ext.is_empty() && EXTENSIONS.contains(&ext.as_str());
    let written = cited_as_written(raw);
    if !written.contains('/') && written.contains('\\') {
        return known || written.starts_with(".\\") || written.starts_with("..\\");
    }
    path.contains('/') || known
}

/// A file link: a workspace path, or one elsewhere written absolute.
pub(crate) fn looks_like_workspace_href(href: &str) -> bool {
    let path = trim(href);
    if path.starts_with('#') || path.starts_with('?') {
        return false;
    }
    looks_like_workspace_path(path)
}

/// `decodePercentPath`: marked encoded CJK hrefs, then `encodeURIComponent` encoded them again;
/// undo until stable (three times at most).
fn decode_percent_path(path: &str) -> String {
    let mut current = path.to_string();
    for _ in 0..3 {
        if !js::has_percent_escape(&current) {
            break;
        }
        match js::decode_uri_component(&current) {
            Some(next) if next != current => current = next,
            _ => break,
        }
    }
    current
}

pub(crate) fn parse_artifact_href(href: &str) -> Option<String> {
    let raw = trim(href);
    let decoded = decode_percent_path(raw.strip_prefix(ARTIFACT_SCHEME)?);
    (!decoded.is_empty()).then_some(decoded)
}

fn unique_paths(paths: &[String]) -> Vec<String> {
    let mut seen = HashSet::new();
    let mut out = Vec::new();
    for raw in paths {
        let path = trim(raw);
        if !path.is_empty() && seen.insert(path.to_string()) {
            out.push(path.to_string());
        }
    }
    out
}

/// The text split into fenced code (` ```…``` ` or `~~~…~~~`, the first closing fence ends it, an
/// unclosed one is no fence) and the rest: `/(```[\s\S]*?```|~~~[\s\S]*?~~~)/g`. Shared with the
/// mention pass, which has the same function.
pub(crate) fn split_fences_lazy(body: &str) -> Vec<(&str, bool)> {
    let b = body.as_bytes();
    let mut parts = Vec::new();
    let mut last = 0;
    let mut p = 0;
    // Once a delimiter has no closing fence left, none after it has either.
    let mut exhausted = [false, false];
    while p + 3 <= b.len() {
        let which = match &b[p..p + 3] {
            b"```" => 0,
            b"~~~" => 1,
            _ => {
                p += 1;
                continue;
            }
        };
        if !exhausted[which] {
            let delim = if which == 0 { "```" } else { "~~~" };
            if let Some(i) = body[p + 3..].find(delim) {
                let end = p + 3 + i + 3;
                if p > last {
                    parts.push((&body[last..p], false));
                }
                parts.push((&body[p..end], true));
                last = end;
                p = end;
                continue;
            }
            exhausted[which] = true;
        }
        p += 1;
    }
    if last < body.len() {
        parts.push((&body[last..], false));
    }
    if parts.is_empty() {
        parts.push((body, false));
    }
    parts
}

/// The pieces of a text set aside behind `\0<tag><n>\0` while a pass works on the rest.
pub(crate) struct Kept(pub Vec<String>);

impl Kept {
    pub fn keep(&mut self, tag: char, piece: &str) -> String {
        self.0.push(piece.to_string());
        format!("\0{tag}{}\0", self.0.len() - 1)
    }
}

/// The next `` `[^`\n]+` `` at or after `from`: where it starts and where its closing tick is.
pub(crate) fn next_code_span(s: &str, from: usize) -> Option<(usize, usize)> {
    let b = s.as_bytes();
    let mut p = from;
    while let Some(i) = s[p..].find('`') {
        p += i;
        if let Some(j) = s[p + 1..].find(['`', '\n']) {
            let q = p + 1 + j;
            if q > p + 1 && b[q] == b'`' {
                return Some((p, q));
            }
        }
        p += 1;
    }
    None
}

/// A destination with a space only parses inside `<…>`.
fn path_link(path: &str) -> String {
    if has_space(path) { format!("[{path}](<{path}>)") } else { format!("[{path}]({path})") }
}

/// A code span names a path when it is shaped like one and is one word, or a known path.
fn code_is_path(code: &str, known: &[String]) -> bool {
    looks_like_workspace_href(code) && (!has_space(code) || known.iter().any(|k| k == code))
}

/// How deep a kept piece may hold another before the restore gives up; the JavaScript would
/// overflow its stack on a text that loops, so nothing real gets near it.
const RESTORE_DEPTH: usize = 64;

fn restore(piece: &str, kept: &[String], depth: usize) -> String {
    if depth > RESTORE_DEPTH {
        return String::new();
    }
    replace_placeholders(piece, b'L', |digits| restore(kept_at(kept, digits), kept, depth + 1))
}

fn linkify_outside_fences(text: &str, known: &[String]) -> String {
    let mut kept = Kept(Vec::new());
    // Links already there are kept whole.
    let mut next = String::with_capacity(text.len());
    let mut from = 0;
    while let Some(link) = next_link(text, from, Label::Plain) {
        next.push_str(&text[from..link.start]);
        next.push_str(&kept.keep('L', &text[link.start..link.end]));
        from = link.end;
    }
    next.push_str(&text[from..]);
    // A code span is kept whole: one that is only a path becomes its link, any other stays code,
    // and no path inside it is linked.
    let mut cited: HashSet<String> = HashSet::new();
    let src = std::mem::take(&mut next);
    let mut from = 0;
    while let Some((p, q)) = next_code_span(&src, from) {
        next.push_str(&src[from..p]);
        let path = trim(&src[p + 1..q]);
        if code_is_path(path, known) {
            cited.insert(path.to_string());
            next.push_str(&kept.keep('L', &path_link(path)));
        } else {
            next.push_str(&kept.keep('L', &src[p..=q]));
        }
        from = q + 1;
    }
    next.push_str(&src[from..]);
    for path in known {
        if path.is_empty() || cited.contains(path) {
            continue;
        }
        next = link_known_path(&next, path, &mut kept);
    }
    restore(&next, &kept.0, 0)
}

/// `(?<![\w./-])PATH(?![\w./-])` replaced by the path's link, wherever it stands.
fn link_known_path(text: &str, path: &str, kept: &mut Kept) -> String {
    let b = text.as_bytes();
    let edge = |i: Option<&u8>| i.is_some_and(|&c| is_word_byte(c) || c == b'.' || c == b'/' || c == b'-');
    let mut out = String::with_capacity(text.len());
    let (mut last, mut from) = (0, 0);
    while let Some(i) = text[from..].find(path) {
        let p = from + i;
        let end = p + path.len();
        if (p == 0 || !edge(b.get(p - 1))) && !edge(b.get(end)) {
            out.push_str(&text[last..p]);
            out.push_str(&kept.keep('L', &path_link(path)));
            last = end;
            from = end;
        } else {
            from = p + text[p..].chars().next().map_or(1, char::len_utf8);
        }
    }
    out.push_str(&text[last..]);
    out
}

/// Known workspace paths (and the code spans that are one) in chat Markdown as links; fenced code
/// is left alone.
pub(crate) fn linkify_workspace_paths(body: &str, extra_paths: &[String]) -> String {
    let mut known = unique_paths(extra_paths);
    known.sort_by_key(|p| std::cmp::Reverse(js::utf16_len(p)));
    split_fences_lazy(body).into_iter().map(|(text, fence)| if fence { text.to_string() } else { linkify_outside_fences(text, &known) }).collect()
}
