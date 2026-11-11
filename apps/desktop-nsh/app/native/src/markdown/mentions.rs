//! `@Name` in chat text: `parseMentions` (`packages/protocol/src/mentions.ts`) and
//! `linkifyRosterMentions` (`apps/messenger/src/lib/chat/mention-chips.ts`).
//!
//! The JavaScript counts in UTF-16 units and this in bytes. Every index here is the same place in
//! the text either way, because each one is found at an ASCII character or is the end of a token
//! cut at one, and the only lengths that are compared are of strings, not positions.

use std::collections::HashMap;

use super::js::{self, decode_uri_component, encode_uri_component, has_decimal_digit, is_space, kept_at, replace_placeholders, trim};
use super::links::{Label, link_at};
use super::paths::{Kept, next_code_span, split_fences_lazy};

const BOT_SCHEME: &str = "bot:";
const UNRESOLVED: &str = "unresolved:";

/// A Bot or member a name can be linked to.
#[derive(Debug, Clone)]
pub(crate) struct Mentionable {
    pub id: String,
    pub name: String,
}

pub(crate) fn parse_mention_href(href: &str) -> Option<String> {
    let id = decode_uri_component(trim(href).strip_prefix(BOT_SCHEME)?)?;
    (!id.is_empty()).then_some(id)
}

fn mention_href(bot_id: &str) -> String {
    format!("{BOT_SCHEME}{}", encode_uri_component(bot_id))
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Kind {
    Everyone,
    Name,
    Lenient,
    Unresolved,
}

#[derive(Debug)]
struct Span {
    start: usize,
    end: usize,
    kind: Kind,
    token: String,
    name: Option<String>,
}

/// Characters that end an `@token` besides white space.
const TOKEN_DELIMITERS: &str = "@,.;:!?()[]{}<>\"'`*/\\|，。、：；！？（）【】「」『』《》〈〉“”‘’…～／";

/// The text after `@` up to white space or punctuation.
fn mention_token(rest: &str) -> &str {
    let end = rest.find(|c: char| is_space(c) || TOKEN_DELIMITERS.contains(c)).unwrap_or(rest.len());
    &rest[..end]
}

/// The single name the token is a prefix or suffix of, ignoring case; tokens under two code
/// points never match.
fn lenient_match<'a>(token: &str, names: &'a [String]) -> Option<&'a String> {
    if token.chars().take(2).count() < 2 {
        return None;
    }
    let needle = token.to_lowercase();
    let mut hits = names.iter().filter(|name| {
        let hay = name.to_lowercase();
        hay.starts_with(&needle) || hay.ends_with(&needle)
    });
    let first = hits.next()?;
    hits.next().is_none().then_some(first)
}

/// `@` glued to an ASCII word or a hyphen, starting a path segment or part of a URL, or opening
/// an npm-style scope is not an attempt to mention anyone. `joined` says a slash follows a mention.
fn looks_like_mention(body: &str, at: usize, token_len: usize, joined: bool) -> bool {
    let b = body.as_bytes();
    if at > 0 {
        let prev = b[at - 1];
        if prev.is_ascii_alphanumeric() || prev == b'_' || prev == b'-' || prev == b'\\' || (prev == b'/' && !joined) {
            return false;
        }
    }
    let end = at + 1 + token_len;
    b.get(end) != Some(&b'/') || b.get(end + 1) == Some(&b'@')
}

/// `[start, end)` of each markdown link target, in order: `](path)` or `](<path>)`.
fn link_targets(body: &str) -> Vec<(usize, usize)> {
    let b = body.as_bytes();
    let mut out = Vec::new();
    let (mut stop, mut angle_stop): (isize, isize) = (-1, -1);
    let stop_from = |angle: bool, from: usize| {
        body[from..].find(|c: char| if angle { c == '>' || c == '\n' } else { c == ')' || is_space(c) }).map_or(body.len(), |i| from + i) as isize
    };
    let mut open = body.find("](");
    while let Some(o) = open {
        let start = o + 2;
        let mut end: Option<usize> = None;
        if b.get(start) == Some(&b'<') {
            if angle_stop <= start as isize {
                angle_stop = stop_from(true, start + 1);
            }
            let a = angle_stop as usize;
            if b.get(a) == Some(&b'>') && b.get(a + 1) == Some(&b')') {
                end = Some(a + 1);
            }
        }
        if end.is_none() {
            if stop < start as isize {
                stop = stop_from(false, start);
            }
            if b.get(stop as usize) == Some(&b')') {
                end = Some(stop as usize);
            }
        }
        if let Some(end) = end {
            let target = &body[start..end];
            let target = if target.len() >= 2 && target.starts_with('<') && target.ends_with('>') { &target[1..target.len() - 1] } else { target };
            if let Some(label) = repeated_label(body, o, target) {
                out.push((label, o));
            }
            out.push((start, end));
        }
        open = body[end.map_or(o + 1, |e| e + 1)..].find("](").map(|i| i + end.map_or(o + 1, |e| e + 1));
    }
    out
}

/// Where the label of a link that repeats its own target starts: `[path](path)`, or `[./path](path)`.
fn repeated_label(body: &str, open: usize, target: &str) -> Option<usize> {
    if target.is_empty() {
        return None;
    }
    let b = body.as_bytes();
    let dotted = format!("./{target}");
    [target, dotted.as_str()].into_iter().find_map(|label| {
        let from = open.checked_sub(label.len())?;
        (from > 0 && b[from - 1] == b'[' && b[from..].starts_with(label.as_bytes())).then_some(from)
    })
}

fn starts_name(literal: &str, rest: &str, names: &[String]) -> bool {
    names.iter().any(|n| n != literal && n.starts_with(literal) && rest.starts_with(n.as_str()))
}

/// Where each `@` in `body` is a mention: of a roster name (longest first), `@everyone`, a member
/// a misspelt token abbreviates (`lenient`), or nobody. An `@` inside a link target is none.
fn parse_mentions(body: &str, roster: &[String], lenient: &[String]) -> Vec<Span> {
    let mut names: Vec<String> = Vec::new();
    for n in roster {
        if !names.contains(n) {
            names.push(n.clone());
        }
    }
    names.sort_by_key(|n| std::cmp::Reverse(js::utf16_len(n)));
    let mut lenient_names: Vec<String> = Vec::new();
    for n in lenient {
        if !lenient_names.contains(n) {
            lenient_names.push(n.clone());
        }
    }
    let targets = link_targets(body);
    let b = body.as_bytes();
    let mut spans = Vec::new();
    let mut t = 0;
    // Where the last `@` that read as a mention ended, so `@A/@B` names both.
    let mut last_end: isize = -1;
    let mut i = 0;
    while i < b.len() {
        if b[i] != b'@' {
            i += 1;
            continue;
        }
        while t < targets.len() && targets[t].1 <= i {
            t += 1;
        }
        if t < targets.len() && targets[t].0 <= i {
            i = targets[t].1;
            continue;
        }
        let at = i;
        let joined = at as isize - 1 == last_end;
        let rest = &body[i + 1..];
        if rest.starts_with("everyone") && !starts_name("everyone", rest, &names) && looks_like_mention(body, i, "everyone".len(), joined) {
            let end = i + 1 + "everyone".len();
            spans.push(Span { start: at, end, kind: Kind::Everyone, token: "everyone".into(), name: None });
            i = end;
            last_end = end as isize;
            continue;
        }
        // An empty name is found last and is no hit.
        if let Some(hit) = names.iter().find(|n| rest.starts_with(n.as_str())).filter(|n| !n.is_empty())
            && looks_like_mention(body, i, hit.len(), joined)
        {
            let end = i + 1 + hit.len();
            spans.push(Span { start: at, end, kind: Kind::Name, token: hit.clone(), name: Some(hit.clone()) });
            i = end;
            last_end = end as isize;
            continue;
        }
        let token = mention_token(rest);
        if !token.is_empty() && looks_like_mention(body, i, token.len(), joined) {
            let end = i + 1 + token.len();
            if let Some(name) = lenient_match(token, &lenient_names) {
                spans.push(Span { start: at, end, kind: Kind::Lenient, token: token.into(), name: Some(name.clone()) });
            } else if !has_decimal_digit(token) {
                spans.push(Span { start: at, end, kind: Kind::Unresolved, token: token.into(), name: None });
            }
            i = end;
            last_end = end as isize;
            continue;
        }
        i += 1 + token.len();
    }
    spans
}

fn escape_label(name: &str) -> String {
    name.chars().filter(|c| !matches!(c, '[' | ']' | '\\')).collect()
}

fn first_by_name(list: &[Mentionable]) -> HashMap<&str, &Mentionable> {
    let mut map = HashMap::new();
    for item in list {
        map.entry(item.name.as_str()).or_insert(item);
    }
    map
}

fn replace_mention_tokens(text: &str, bots: &[Mentionable], members: &[Mentionable]) -> String {
    let by_name = first_by_name(bots);
    let member_by_name = first_by_name(members);
    // Keys in the order they were first seen, as a `Map`'s are.
    let ordered = |list: &[Mentionable], map: &HashMap<&str, &Mentionable>| -> Vec<String> {
        let mut seen: Vec<String> = Vec::new();
        for item in list {
            if map.contains_key(item.name.as_str()) && !seen.contains(&item.name) {
                seen.push(item.name.clone());
            }
        }
        seen
    };
    let spans = parse_mentions(text, &ordered(bots, &by_name), &ordered(members, &member_by_name));
    let mut out = String::with_capacity(text.len());
    let mut i = 0;
    for span in &spans {
        out.push_str(&text[i..span.start]);
        match span.kind {
            Kind::Everyone => out.push_str(&format!("[@everyone]({BOT_SCHEME}everyone)")),
            Kind::Name | Kind::Lenient => {
                let bot = span.name.as_deref().filter(|n| !n.is_empty()).and_then(|n| by_name.get(n).or_else(|| member_by_name.get(n)));
                match bot {
                    Some(bot) => out.push_str(&format!("[@{}]({})", escape_label(&bot.name), mention_href(&bot.id))),
                    None => out.push_str(&text[span.start..span.end]),
                }
            }
            Kind::Unresolved => out.push_str(&format!("[@{}]({})", escape_label(&span.token), mention_href(&format!("{UNRESOLVED}{}", span.token)))),
        }
        i = span.end;
    }
    out.push_str(&text[i..]);
    out
}

fn replace_mentions_outside_code(text: &str, bots: &[Mentionable], members: &[Mentionable]) -> String {
    let mut kept = Kept(Vec::new());
    // Links and images are set aside whole: `!?\[(?:[^\]]*)\]\((?:<[^>]+>|[^)\s]+)\)`.
    let mut next = String::with_capacity(text.len());
    let mut from = 0;
    let mut p = 0;
    while let Some(i) = text[p..].find('[') {
        p += i;
        if let Some(link) = link_at(text, p, Label::Plain, |_| true) {
            let start = if p > from && text.as_bytes()[p - 1] == b'!' { p - 1 } else { p };
            next.push_str(&text[from..start]);
            next.push_str(&kept.keep('M', &text[start..link.end]));
            from = link.end;
            p = link.end;
        } else {
            p += 1;
        }
    }
    next.push_str(&text[from..]);
    let src = std::mem::take(&mut next);
    let mut from = 0;
    while let Some((p, q)) = next_code_span(&src, from) {
        next.push_str(&src[from..p]);
        next.push_str(&kept.keep('M', &src[p..=q]));
        from = q + 1;
    }
    next.push_str(&src[from..]);
    let next = replace_mention_tokens(&next, bots, members);
    replace_placeholders(&next, b'M', |digits| kept_at(&kept.0, digits).to_string())
}

/// Roster `@Name` / `@everyone` as Markdown links; fenced code and inline code are left alone.
pub(crate) fn linkify_roster_mentions(body: &str, bots: &[Mentionable], members: &[Mentionable]) -> String {
    if body.is_empty() || bots.is_empty() {
        return body.to_string();
    }
    split_fences_lazy(body).into_iter().map(|(text, fence)| if fence { text.to_string() } else { replace_mentions_outside_code(text, bots, members) }).collect()
}
