//! What the JavaScript the port replaces does with strings, where Rust's own differs: which
//! characters are white space, what `decodeURIComponent` accepts, which are digits.

use std::sync::OnceLock;

use regex::Regex;

/// JavaScript's `\s`, and what `String.prototype.trim` strips.
pub(crate) fn is_space(c: char) -> bool {
    matches!(
        c,
        '\t' | '\n' | '\u{b}' | '\u{c}' | '\r' | ' ' | '\u{a0}' | '\u{1680}' | '\u{2000}'..='\u{200a}' | '\u{2028}' | '\u{2029}' | '\u{202f}' | '\u{205f}' | '\u{3000}' | '\u{feff}'
    )
}

/// What `.` does not match in a JavaScript regex.
pub(crate) fn is_line_terminator(c: char) -> bool {
    matches!(c, '\n' | '\r' | '\u{2028}' | '\u{2029}')
}

pub(crate) fn trim(s: &str) -> &str {
    s.trim_matches(is_space)
}

pub(crate) fn has_space(s: &str) -> bool {
    s.chars().any(is_space)
}

/// `[A-Za-z0-9_]`: `\w` without the `u` flag is ASCII only.
pub(crate) fn is_word_byte(b: u8) -> bool {
    b.is_ascii_alphanumeric() || b == b'_'
}

/// A string's length in UTF-16 code units, which is what `.length` sorts by.
pub(crate) fn utf16_len(s: &str) -> usize {
    s.encode_utf16().count()
}

/// `/\p{Nd}/u.test(s)`.
pub(crate) fn has_decimal_digit(s: &str) -> bool {
    static ND: OnceLock<Regex> = OnceLock::new();
    ND.get_or_init(|| Regex::new(r"\p{Nd}").expect("a fixed pattern")).is_match(s)
}

fn hex(b: u8) -> Option<u8> {
    (b as char).to_digit(16).map(|d| d as u8)
}

/// `/%[0-9A-Fa-f]{2}/.test(s)`.
pub(crate) fn has_percent_escape(s: &str) -> bool {
    let b = s.as_bytes();
    (0..b.len()).any(|i| percent_byte(b, i).is_some())
}

fn percent_byte(b: &[u8], i: usize) -> Option<u8> {
    if b.get(i) != Some(&b'%') {
        return None;
    }
    Some(hex(*b.get(i + 1)?)? << 4 | hex(*b.get(i + 2)?)?)
}

/// `decodeURIComponent`, or `None` where it throws: a `%` without two hex digits, or escaped bytes
/// that are not one well-formed UTF-8 character.
pub(crate) fn decode_uri_component(s: &str) -> Option<String> {
    let b = s.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] != b'%' {
            out.push(b[i]);
            i += 1;
            continue;
        }
        let first = percent_byte(b, i)?;
        i += 3;
        if first < 0x80 {
            out.push(first);
            continue;
        }
        let n = first.leading_ones() as usize;
        if !(2..=4).contains(&n) {
            return None;
        }
        let mut bytes = vec![first];
        for _ in 1..n {
            bytes.push(percent_byte(b, i)?);
            i += 3;
        }
        std::str::from_utf8(&bytes).ok()?;
        out.extend_from_slice(&bytes);
    }
    String::from_utf8(out).ok()
}

/// `encodeURIComponent`.
pub(crate) fn encode_uri_component(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for &b in s.as_bytes() {
        if b.is_ascii_alphanumeric() || b"-_.!~*'()".contains(&b) {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

/// The text of every `\0<tag><digits>\0` placeholder in `s`, replaced by `f(digits)`; the rest is
/// kept. Digits are ASCII, as `\d` is in a JavaScript regex without the `u` flag.
pub(crate) fn replace_placeholders(s: &str, tag: u8, mut f: impl FnMut(&str) -> String) -> String {
    let b = s.as_bytes();
    let mut out = String::with_capacity(s.len());
    let mut last = 0;
    let mut from = 0;
    while let Some(at) = s[from..].find('\0') {
        let p = from + at;
        let mut q = p + 2;
        if b.get(p + 1) == Some(&tag) {
            while q < b.len() && b[q].is_ascii_digit() {
                q += 1;
            }
            if q > p + 2 && b.get(q) == Some(&0) {
                out.push_str(&s[last..p]);
                out.push_str(&f(&s[p + 2..q]));
                last = q + 1;
                from = q + 1;
                continue;
            }
        }
        from = p + 1;
    }
    out.push_str(&s[last..]);
    out
}

/// `kept[Number(digits)] ?? ""`.
pub(crate) fn kept_at<'a>(kept: &'a [String], digits: &str) -> &'a str {
    digits.parse::<usize>().ok().and_then(|i| kept.get(i)).map_or("", String::as_str)
}
