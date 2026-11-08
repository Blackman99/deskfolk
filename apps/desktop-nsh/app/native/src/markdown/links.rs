//! Finding Markdown inline links the way the JavaScript's regexes do, by hand: a label in `[…]`,
//! then a target in `(…)` that is either `<…>` or a run of characters without `)` or white space.
//! Every offset is a byte offset at an ASCII character, so slicing at it is always safe.
//!
//! The regexes are `\[(?:[^\]]*)\]\((?:<[^>]+>|[^)\s]+)\)` (a label ends at the first `]`) and
//! `(?<!!)\[((?:\\.|[^\]\\])*)\]\((<[^>]+>|[^)\s]+)\)` (a label may hold escaped brackets, and the
//! `[` is not an image's). Neither needs backtracking beyond choosing between the two target
//! shapes, which is what `link_at` tries in turn.

use super::js::{is_line_terminator, is_space};

#[derive(Clone, Copy, PartialEq, Eq)]
pub(crate) enum Label {
    /// `[^\]]*`
    Plain,
    /// `(?:\\.|[^\]\\])*`
    Escaped,
}

#[derive(Debug, Clone, Copy)]
pub(crate) struct Link {
    pub start: usize,
    /// Inside the brackets.
    pub label: (usize, usize),
    /// What stands between the parentheses, `<…>` included.
    pub target: (usize, usize),
    /// After the closing `)`.
    pub end: usize,
}

/// The `]` that ends a label opened just before `from`.
fn label_end(s: &str, from: usize, kind: Label) -> Option<usize> {
    match kind {
        Label::Plain => s[from..].find(']').map(|i| from + i),
        Label::Escaped => {
            let mut chars = s[from..].char_indices();
            while let Some((i, c)) = chars.next() {
                match c {
                    ']' => return Some(from + i),
                    '\\' => match chars.next() {
                        Some((_, n)) if !is_line_terminator(n) => {}
                        _ => return None,
                    },
                    _ => {}
                }
            }
            None
        }
    }
}

/// The two ways a target can end after the `(` before `from`: as `<[^>]+>` then `)`, and as
/// `[^)\s]+` then `)`; each the index after the `)`.
fn target_ends(s: &str, from: usize) -> [Option<usize>; 2] {
    let b = s.as_bytes();
    let angle = (b.get(from) == Some(&b'<'))
        .then(|| s[from + 1..].find('>').map(|i| from + 1 + i))
        .flatten()
        .filter(|&gt| gt > from + 1 && b.get(gt + 1) == Some(&b')'))
        .map(|gt| gt + 2);
    let stop = s[from..].find(|c: char| c == ')' || is_space(c)).map_or(s.len(), |i| from + i);
    let plain = (stop > from && b.get(stop) == Some(&b')')).then_some(stop + 1);
    [angle, plain]
}

/// The link that starts with the `[` at `p`, whose end `accept` allows; the first target shape
/// that gets there wins, as in the regex's alternation.
pub(crate) fn link_at(s: &str, p: usize, kind: Label, accept: impl Fn(usize) -> bool) -> Option<Link> {
    let close = label_end(s, p + 1, kind)?;
    if s.as_bytes().get(close + 1) != Some(&b'(') {
        return None;
    }
    let from = close + 2;
    target_ends(s, from).into_iter().flatten().find(|&end| accept(end)).map(|end| Link { start: p, label: (p + 1, close), target: (from, end - 1), end })
}

/// The first link at or after `from`. With `Label::Escaped` a `[` right after a `!` does not
/// start one.
pub(crate) fn next_link(s: &str, from: usize, kind: Label) -> Option<Link> {
    next_link_with(s, from, kind, |_| true)
}

pub(crate) fn next_link_with(s: &str, from: usize, kind: Label, accept: impl Fn(usize) -> bool + Copy) -> Option<Link> {
    let b = s.as_bytes();
    // A plain label ends at the first `]`, so no `[` past the last `]` can start a link.
    let last_close = if kind == Label::Plain { s.rfind(']') } else { Some(s.len()) };
    let mut p = from;
    while let Some(i) = s[p..].find('[') {
        p += i;
        if last_close.is_none_or(|c| c < p) {
            return None;
        }
        let image = kind == Label::Escaped && p > 0 && b[p - 1] == b'!';
        if !image {
            if let Some(link) = link_at(s, p, kind, accept) {
                return Some(link);
            }
        }
        p += 1;
    }
    None
}
