//! Marking external `http://` / `https://` links with `<extlink></extlink>` so `MarkdownBody`
//! draws an external-open icon inline with the link text.
//!
//! Mirrors `apps/desktop-nsh/app/src/ui/markdown.ts` byte for byte.

use super::js::is_space;

pub(crate) fn ext_link_tag(url: &str) -> String {
    let escaped = url.replace('&', "&amp;").replace('"', "&quot;").replace('<', "&lt;");
    format!("<extlink url=\"{escaped}\"></extlink>")
}

pub(crate) fn is_external_http_url(url: &str) -> bool {
    let b = url.as_bytes();
    (b.len() > 8 && b[..8].eq_ignore_ascii_case(b"https://"))
        || (b.len() > 7 && b[..7].eq_ignore_ascii_case(b"http://"))
}

/// Whether a matched link label contains an inline image marker (`![`), as in `[![badge](img)](url)`.
/// Leaving such matches untouched avoids injecting `<extlink>` into an image's alt text.
pub(crate) fn has_image_marker(label: &str) -> bool {
    label.contains("![")
}

fn scheme_len(s: &str, at: usize) -> Option<usize> {
    let rest = &s.as_bytes()[at..];
    if rest.len() >= 8 && rest[..8].eq_ignore_ascii_case(b"https://") {
        Some(8)
    } else if rest.len() >= 7 && rest[..7].eq_ignore_ascii_case(b"http://") {
        Some(7)
    } else {
        None
    }
}

fn is_cjk_punctuation(c: char) -> bool {
    matches!(
        c,
        '‘' | '’'
            | '“'
            | '”'
            | '\u{3000}'..='\u{303F}'
            | '\u{FE10}'..='\u{FE1F}'
            | '\u{FE30}'..='\u{FE6F}'
            | '\u{FF01}'..='\u{FF0F}'
            | '\u{FF1A}'..='\u{FF20}'
            | '\u{FF3B}'..='\u{FF40}'
            | '\u{FF5B}'..='\u{FF65}'
    )
}

fn is_cjk_char(c: char) -> bool {
    matches!(
        c,
        '\u{3400}'..='\u{4DBF}'
            | '\u{4E00}'..='\u{9FFF}'
            | '\u{F900}'..='\u{FAFF}'
            | '\u{3040}'..='\u{30FF}'
            | '\u{AC00}'..='\u{D7AF}'
    )
}

fn escape_md_label(url: &str) -> String {
    let mut out = String::with_capacity(url.len());
    for c in url.chars() {
        if matches!(c, '\\' | '[' | ']') {
            out.push('\\');
        }
        out.push(c);
    }
    out
}

fn trim_url_end(s: &str, start: usize, mut end: usize, min_end: usize) -> usize {
    let b = s.as_bytes();
    while end > min_end {
        let last = b[end - 1];
        if matches!(last, b'.' | b',' | b';' | b':' | b'!' | b'?' | b'*' | b'_' | b'~') {
            end -= 1;
            continue;
        }
        if last == b')' {
            let slice = &b[start..end];
            let opens = slice.iter().filter(|&&x| x == b'(').count();
            let closes = slice.iter().filter(|&&x| x == b')').count();
            if closes > opens {
                end -= 1;
                continue;
            }
        }
        if last == b']' {
            let slice = &b[start..end];
            let opens = slice.iter().filter(|&&x| x == b'[').count();
            let closes = slice.iter().filter(|&&x| x == b']').count();
            if closes > opens {
                end -= 1;
                continue;
            }
        }
        break;
    }
    end
}

fn can_start_bare_url(s: &str, at: usize) -> bool {
    let b = s.as_bytes();
    if at > 0 {
        let prev = b[at - 1];
        if prev.is_ascii_alphanumeric() || matches!(prev, b'_' | b'=' | b'"' | b'\'' | b'<' | 0) {
            return false;
        }
    }
    let written = s[..at].trim_end_matches([' ', '\t']);
    if written.ends_with("](") || written.ends_with("](<") || written.ends_with("]:") {
        return false;
    }
    true
}

/// Converts angle-bracket `<https?://...>` and bare `https?://...` URLs in a plain text segment
/// (outside code fences, code spans and matched Markdown links) into Markdown links carrying
/// `<extlink></extlink>`.
pub(crate) fn linkify_external_urls(segment: &str, out: &mut String) {
    let b = segment.as_bytes();
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'<' {
            // Angle-bracket autolink: `<http://...>` or `<https://...>`.
            if let Some(slen) = scheme_len(segment, i + 1) {
                let url_start = i + 1;
                let mut j = url_start + slen;
                let mut closed = false;
                for (off, c) in segment[j..].char_indices() {
                    if c == '>' {
                        j += off;
                        closed = true;
                        break;
                    }
                    if is_space(c) || c == '<' || c == '\0' {
                        break;
                    }
                }
                if closed && j > url_start + slen {
                    let url = &segment[url_start..j];
                    out.push('[');
                    out.push_str(&escape_md_label(url));
                    out.push_str("](<");
                    out.push_str(url);
                    out.push_str(">)");
                    out.push_str(&ext_link_tag(url));
                    i = j + 1;
                    continue;
                }
            }
            // HTML tag (`<a href="...">`, `<img ...>`, `</tag>`): copy verbatim so attributes are untouched.
            if let Some(&next) = b.get(i + 1)
                && (next.is_ascii_alphabetic() || matches!(next, b'/' | b'!' | b'?'))
            {
                let mut gt = None;
                for (off, byte) in b[i + 1..].iter().enumerate() {
                    if *byte == b'>' {
                        gt = Some(i + 1 + off);
                        break;
                    }
                    if *byte == b'<' || *byte == 0 {
                        break;
                    }
                }
                if let Some(end_gt) = gt {
                    out.push_str(&segment[i..=end_gt]);
                    i = end_gt + 1;
                    continue;
                }
            }
        }

        if matches!(b[i], b'h' | b'H')
            && let Some(slen) = scheme_len(segment, i)
            && can_start_bare_url(segment, i)
        {
            let body_start = i + slen;
            let mut end = segment.len();
            let mut in_path = false;
            for (off, c) in segment[body_start..].char_indices() {
                if is_space(c)
                    || matches!(c, '<' | '>' | '"' | '\'' | '`' | '\\' | '\0')
                    || is_cjk_punctuation(c)
                    || (!in_path && is_cjk_char(c))
                {
                    end = body_start + off;
                    break;
                }
                if c == '/' {
                    in_path = true;
                }
            }
            end = trim_url_end(segment, i, end, body_start);
            if end > body_start {
                let url = &segment[i..end];
                out.push('[');
                out.push_str(&escape_md_label(url));
                out.push_str("](<");
                out.push_str(url);
                out.push_str(">)");
                out.push_str(&ext_link_tag(url));
                i = end;
                continue;
            }
        }

        let c = segment[i..].chars().next().unwrap();
        out.push(c);
        i += c.len_utf8();
    }
}
