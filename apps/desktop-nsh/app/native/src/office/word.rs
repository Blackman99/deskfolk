//! Word (docx) as a flowing block model for `TextView`'s `document`: headings (a style named
//! `heading N` or `Title`, or an outline level, through `basedOn`), paragraphs with runs (bold,
//! italic, underline, strike, super/subscript, a monospace face as code, colour, highlight,
//! hyperlinks), bullet and numbered lists by `numbering.xml` levels, tables (`custom` blocks named
//! `table`, with grid widths, column spans and vertical merges), pictures (`office-image:<part>`
//! sources, sized from their extents in points) and page breaks (a `rule`).
//!
//! Not read: headers, footers, footnotes, comments, text boxes, fields' instructions, tracked
//! deletions, columns, page geometry and fonts.

use std::collections::HashMap;

use serde_json::{Value, json};

use super::archive::{Package, relationships};
use super::xml::Node;

const MAIN: &str = "word/document.xml";

#[derive(Default, Clone)]
struct Fmt {
    bold: bool,
    italic: bool,
    underline: bool,
    strike: bool,
    mono: bool,
    sup: bool,
    sub: bool,
    color: Option<String>,
    highlight: Option<String>,
}

fn on(node: &Node) -> bool {
    !matches!(node.attr("val"), Some("0" | "false" | "off" | "none"))
}

impl Fmt {
    fn apply(&mut self, rpr: &Node) {
        for p in &rpr.children {
            match p.name.as_str() {
                "b" => self.bold = on(p),
                "i" => self.italic = on(p),
                "u" => self.underline = p.attr("val") != Some("none"),
                "strike" | "dstrike" => self.strike = on(p),
                "vertAlign" => {
                    self.sup = p.attr("val") == Some("superscript");
                    self.sub = p.attr("val") == Some("subscript");
                }
                "color" => {
                    self.color = match p.attr("val") {
                        Some(v) if v.len() == 6 && v.chars().all(|c| c.is_ascii_hexdigit()) && !v.eq_ignore_ascii_case("000000") => Some(format!("#{}", v.to_ascii_lowercase())),
                        _ => None,
                    }
                }
                "highlight" => self.highlight = highlight(p.attr("val")),
                "rFonts" => {
                    let face = p.attr("ascii").or(p.attr("hAnsi")).unwrap_or("").to_ascii_lowercase();
                    self.mono = ["courier", "consolas", "menlo", "monaco", "mono", "lucida console"].iter().any(|m| face.contains(m));
                }
                _ => {}
            }
        }
    }
}

fn highlight(name: Option<&str>) -> Option<String> {
    let hex = match name? {
        "yellow" => "ffff00",
        "green" => "00ff00",
        "cyan" => "00ffff",
        "magenta" => "ff00ff",
        "blue" => "0000ff",
        "red" => "ff0000",
        "darkBlue" => "000080",
        "darkCyan" => "008080",
        "darkGreen" => "008000",
        "darkMagenta" => "800080",
        "darkRed" => "800000",
        "darkYellow" => "808000",
        "darkGray" => "808080",
        "lightGray" => "c0c0c0",
        _ => return None,
    };
    Some(format!("#{hex}"))
}

#[derive(Default, Clone)]
struct Style {
    name: String,
    based_on: Option<String>,
    outline: Option<u32>,
    num: Option<(String, u32)>,
    rpr: Option<Node>,
    jc: Option<String>,
}

#[derive(Default)]
struct Level {
    ordered: bool,
    start: u32,
}

struct Doc<'a> {
    pkg: &'a mut Package,
    rels: HashMap<String, (String, bool)>,
    styles: HashMap<String, Style>,
    nums: HashMap<String, String>,
    abstracts: HashMap<String, HashMap<u32, Level>>,
    overrides: HashMap<(String, u32), u32>,
    counters: HashMap<(String, u32), u32>,
}

struct Item {
    level: u32,
    ordered: bool,
    start: u32,
    blocks: Vec<Value>,
}

pub fn read(pkg: &mut Package) -> Result<Value, String> {
    let root = pkg.xml(MAIN).ok_or(super::archive::INVALID)?;
    let rels = relationships(pkg, MAIN);
    let mut doc = Doc { pkg, rels, styles: HashMap::new(), nums: HashMap::new(), abstracts: HashMap::new(), overrides: HashMap::new(), counters: HashMap::new() };
    doc.load_styles();
    doc.load_numbering();
    let body = root.child("body").ok_or(super::archive::INVALID)?;
    let blocks = doc.blocks(body);
    Ok(json!({ "kind": "word", "blocks": blocks }))
}

impl Doc<'_> {
    fn load_styles(&mut self) {
        let Some(root) = self.pkg.xml("word/styles.xml") else { return };
        for s in root.kids("style") {
            let Some(id) = s.attr("styleId") else { continue };
            let ppr = s.child("pPr");
            let num = ppr.and_then(|p| p.child("numPr")).and_then(|n| {
                let id = n.child("numId")?.attr("val")?.to_string();
                Some((id, n.child("ilvl").and_then(|l| l.num("val")).unwrap_or(0.0) as u32))
            });
            self.styles.insert(
                id.to_string(),
                Style {
                    name: s.child("name").and_then(|n| n.attr("val")).unwrap_or("").to_ascii_lowercase(),
                    based_on: s.child("basedOn").and_then(|n| n.attr("val")).map(String::from),
                    outline: ppr.and_then(|p| p.child("outlineLvl")).and_then(|n| n.num("val")).map(|v| v as u32),
                    num,
                    rpr: s.child("rPr").cloned(),
                    jc: ppr.and_then(|p| p.child("jc")).and_then(|n| n.attr("val")).map(String::from),
                },
            );
        }
    }

    fn load_numbering(&mut self) {
        let Some(root) = self.pkg.xml("word/numbering.xml") else { return };
        for a in root.kids("abstractNum") {
            let Some(id) = a.attr("abstractNumId") else { continue };
            let mut levels = HashMap::new();
            for l in a.kids("lvl") {
                let ilvl = l.num("ilvl").unwrap_or(0.0) as u32;
                let fmt = l.child("numFmt").and_then(|n| n.attr("val")).unwrap_or("bullet");
                levels.insert(ilvl, Level { ordered: fmt != "bullet" && fmt != "none", start: l.child("start").and_then(|n| n.num("val")).unwrap_or(1.0) as u32 });
            }
            self.abstracts.insert(id.to_string(), levels);
        }
        for n in root.kids("num") {
            let (Some(id), Some(abs)) = (n.attr("numId"), n.child("abstractNumId").and_then(|a| a.attr("val"))) else { continue };
            self.nums.insert(id.to_string(), abs.to_string());
            for o in n.kids("lvlOverride") {
                if let (Some(l), Some(start)) = (o.num("ilvl"), o.child("startOverride").and_then(|s| s.num("val"))) {
                    self.overrides.insert((id.to_string(), l as u32), start as u32);
                }
            }
        }
    }

    /// The style and everything it is based on, the base first.
    fn chain(&self, id: &str) -> Vec<&Style> {
        let mut out = Vec::new();
        let mut at = Some(id);
        while let Some(current) = at {
            let Some(style) = self.styles.get(current) else { break };
            if out.len() > 16 {
                break;
            }
            out.push(style);
            at = style.based_on.as_deref();
        }
        out.reverse();
        out
    }

    fn heading_level(&self, style: Option<&str>, direct_outline: Option<u32>) -> Option<u8> {
        if let Some(o) = direct_outline.filter(|o| *o < 9) {
            return Some((o + 1).min(6) as u8);
        }
        let chain = self.chain(style?);
        let derived = chain.last()?;
        if derived.name == "title" {
            return Some(1);
        }
        for s in chain.iter().rev() {
            let name = s.name.replace(' ', "");
            if let Some(n) = name.strip_prefix("heading").and_then(|n| n.parse::<u8>().ok()) {
                return Some(n.clamp(1, 6));
            }
            if let Some(o) = s.outline.filter(|o| *o < 9) {
                return Some((o + 1).min(6) as u8);
            }
        }
        None
    }

    fn blocks(&mut self, parent: &Node) -> Vec<Value> {
        let mut out = Vec::new();
        let mut items: Vec<Item> = Vec::new();
        self.walk(parent, &mut out, &mut items);
        self.flush(&mut items, &mut out);
        out
    }

    fn walk(&mut self, parent: &Node, out: &mut Vec<Value>, items: &mut Vec<Item>) {
        for node in &parent.children {
            match node.name.as_str() {
                "p" => self.paragraph(node, out, items),
                "tbl" => {
                    self.flush(items, out);
                    if let Some(table) = self.table(node) {
                        out.push(table);
                    }
                }
                "sdt" => {
                    if let Some(content) = node.child("sdtContent") {
                        self.walk(content, out, items);
                    }
                }
                "ins" | "customXml" | "smartTag" => self.walk(node, out, items),
                _ => {}
            }
        }
    }

    fn flush(&mut self, items: &mut Vec<Item>, out: &mut Vec<Value>) {
        let mut at = 0;
        while at < items.len() {
            let first = items[at].level;
            out.push(build_list(items, &mut at, first));
        }
        items.clear();
    }

    fn paragraph(&mut self, p: &Node, out: &mut Vec<Value>, items: &mut Vec<Item>) {
        let ppr = p.child("pPr");
        let style_id = ppr.and_then(|n| n.child("pStyle")).and_then(|n| n.attr("val")).map(String::from);
        let outline = ppr.and_then(|n| n.child("outlineLvl")).and_then(|n| n.num("val")).map(|v| v as u32);
        let heading = self.heading_level(style_id.as_deref(), outline);
        let mut base = Fmt::default();
        if heading.is_none() {
            for s in style_id.as_deref().map(|id| self.chain(id)).unwrap_or_default() {
                if let Some(r) = &s.rpr {
                    base.apply(r);
                }
            }
        }
        let mut inlines = Vec::new();
        self.inlines(p, &base, &mut inlines);

        // The list a paragraph belongs to: its own numbering, else its style's.
        let mut num = ppr.and_then(|n| n.child("numPr")).and_then(|n| {
            Some((n.child("numId")?.attr("val")?.to_string(), n.child("ilvl").and_then(|l| l.num("val")).unwrap_or(0.0) as u32))
        });
        if num.is_none() && heading.is_none() {
            for s in style_id.as_deref().map(|id| self.chain(id)).unwrap_or_default() {
                if let Some(n) = &s.num {
                    num = Some(n.clone());
                }
            }
        }
        let num = num.filter(|(id, _)| id != "0");
        let jc = ppr.and_then(|n| n.child("jc")).and_then(|n| n.attr("val")).map(String::from).or_else(|| {
            style_id.as_deref().and_then(|id| self.chain(id).iter().rev().find_map(|s| s.jc.clone()))
        });
        let before = ppr.and_then(|n| n.child("pageBreakBefore")).is_some_and(on);

        // A page break inside the paragraph splits it.
        let mut segments: Vec<Vec<Value>> = vec![Vec::new()];
        for inline in inlines {
            if inline["type"] == "pagebreak" {
                segments.push(Vec::new());
            } else {
                segments.last_mut().expect("one").push(inline);
            }
        }
        let mut first = true;
        for (i, segment) in segments.into_iter().enumerate() {
            if (before && i == 0) || i > 0 {
                self.flush(items, out);
                out.push(json!({ "type": "rule" }));
            }
            let blank = segment.iter().all(|s| s["type"] == "text" && s["text"].as_str().is_none_or(|t| t.trim().is_empty()));
            if blank {
                continue;
            }
            if let (Some(level), true) = (heading, first) {
                self.flush(items, out);
                out.push(json!({ "type": "heading", "level": level, "content": segment }));
            } else if let (Some((id, ilvl)), true) = (&num, i == 0) {
                let (ordered, start) = self.counter(id, *ilvl);
                items.push(Item { level: *ilvl, ordered, start, blocks: vec![json!({ "type": "paragraph", "content": segment })] });
            } else {
                self.flush(items, out);
                let para = json!({ "type": "paragraph", "content": segment });
                out.push(match jc.as_deref() {
                    Some(a @ ("center" | "right" | "end")) => {
                        json!({ "type": "custom", "name": "aligned", "data": { "align": if a == "center" { "center" } else { "right" } }, "children": [para] })
                    }
                    _ => para,
                });
            }
            first = false;
        }
    }

    /// Whether level `ilvl` of list `num` is numbered, and the number this item has (counted
    /// across the whole document, as Word does).
    fn counter(&mut self, num: &str, ilvl: u32) -> (bool, u32) {
        let level = self.nums.get(num).and_then(|a| self.abstracts.get(a)).and_then(|l| l.get(&ilvl));
        let (ordered, start) = level.map(|l| (l.ordered, l.start)).unwrap_or((false, 1));
        let start = self.overrides.get(&(num.to_string(), ilvl)).copied().unwrap_or(start);
        self.counters.retain(|(n, l), _| n != num || *l <= ilvl);
        let seen = self.counters.entry((num.to_string(), ilvl)).or_insert(0);
        let number = start + *seen;
        *seen += 1;
        (ordered, number)
    }

    fn inlines(&mut self, parent: &Node, fmt: &Fmt, out: &mut Vec<Value>) {
        for node in &parent.children {
            match node.name.as_str() {
                "r" => self.run(node, fmt, out),
                "hyperlink" => {
                    let url = match node.attr("r:id").and_then(|id| self.rels.get(id)) {
                        Some((target, true)) => Some(target.clone()),
                        _ => node.attr("anchor").map(|a| format!("#{a}")),
                    };
                    let mut content = Vec::new();
                    self.inlines(node, fmt, &mut content);
                    match url {
                        Some(url) if !content.is_empty() => out.push(json!({ "type": "link", "url": url, "content": content })),
                        _ => out.extend(content),
                    }
                }
                "ins" | "smartTag" | "fldSimple" | "customXml" => self.inlines(node, fmt, out),
                "sdt" => {
                    if let Some(content) = node.child("sdtContent") {
                        self.inlines(content, fmt, out);
                    }
                }
                _ => {}
            }
        }
    }

    fn run(&mut self, r: &Node, base: &Fmt, out: &mut Vec<Value>) {
        let mut fmt = base.clone();
        if let Some(style) = r.child("rPr").and_then(|p| p.child("rStyle")).and_then(|s| s.attr("val")) {
            for s in self.chain(style) {
                if let Some(p) = &s.rpr {
                    fmt.apply(p);
                }
            }
        }
        if let Some(rpr) = r.child("rPr") {
            fmt.apply(rpr);
        }
        let mut text = String::new();
        let flush = |text: &mut String, out: &mut Vec<Value>| {
            if !text.is_empty() {
                out.push(decorate(std::mem::take(text), &fmt));
            }
        };
        for part in &r.children {
            match part.name.as_str() {
                "t" => text.push_str(&part.text),
                "tab" => text.push('\t'),
                "noBreakHyphen" => text.push('\u{2011}'),
                "cr" => {
                    flush(&mut text, out);
                    out.push(json!({ "type": "break" }));
                }
                "br" => {
                    flush(&mut text, out);
                    if part.attr("type") == Some("page") {
                        out.push(json!({ "type": "pagebreak" }));
                    } else {
                        out.push(json!({ "type": "break" }));
                    }
                }
                "drawing" | "pict" => {
                    flush(&mut text, out);
                    if let Some(image) = self.image(part) {
                        out.push(image);
                    }
                }
                "AlternateContent" => {
                    flush(&mut text, out);
                    let chosen = part.child("Choice").or_else(|| part.child("Fallback"));
                    if let Some(drawing) = chosen.and_then(|c| c.child("drawing").or_else(|| c.child("pict"))) {
                        if let Some(image) = self.image(drawing) {
                            out.push(image);
                        }
                    }
                }
                _ => {}
            }
        }
        flush(&mut text, out);
    }

    fn image(&self, drawing: &Node) -> Option<Value> {
        let id = if drawing.name == "pict" { drawing.find("imagedata")?.attr("r:id")? } else { drawing.find("blip")?.attr("r:embed")? };
        let (part, external) = self.rels.get(id)?;
        if *external {
            return None;
        }
        let mut image = json!({ "type": "image", "src": format!("office-image:{part}") });
        if let Some(extent) = drawing.find("extent") {
            if let (Some(cx), Some(cy)) = (extent.num("cx"), extent.num("cy")) {
                image["width"] = json!((cx / 12700.0 * 10.0).round() / 10.0);
                image["height"] = json!((cy / 12700.0 * 10.0).round() / 10.0);
            }
        } else if let Some(style) = drawing.find("shape").and_then(|s| s.attr("style")) {
            let size = |key: &str| {
                style.split(';').find_map(|kv| {
                    let (k, v) = kv.split_once(':')?;
                    (k.trim() == key).then(|| v.trim().strip_suffix("pt").and_then(|n| n.parse::<f64>().ok())).flatten()
                })
            };
            if let (Some(w), Some(h)) = (size("width"), size("height")) {
                image["width"] = json!(w);
                image["height"] = json!(h);
            }
        }
        if let Some(alt) = drawing.find("docPr").and_then(|d| d.attr("descr")).filter(|a| !a.is_empty()) {
            image["alt"] = json!(alt);
        }
        Some(image)
    }

    fn table(&mut self, tbl: &Node) -> Option<Value> {
        let widths: Vec<f64> = tbl.child("tblGrid").map(|g| g.kids("gridCol").map(|c| c.num("w").unwrap_or(0.0) / 20.0).collect()).unwrap_or_default();
        let mut rows = Vec::new();
        for tr in tbl.kids("tr") {
            let mut cells = Vec::new();
            for tc in tr.kids("tc") {
                let pr = tc.child("tcPr");
                let span = pr.and_then(|p| p.child("gridSpan")).and_then(|g| g.num("val")).unwrap_or(1.0).max(1.0) as u32;
                let merge = pr.and_then(|p| p.child("vMerge")).map(|m| if m.attr("val") == Some("restart") { "restart" } else { "continue" });
                let fill = pr.and_then(|p| p.child("shd")).and_then(|s| s.attr("fill")).filter(|f| f.len() == 6 && f.chars().all(|c| c.is_ascii_hexdigit())).map(|f| format!("#{}", f.to_ascii_lowercase()));
                let blocks = if merge == Some("continue") { Vec::new() } else { self.blocks(tc) };
                cells.push(json!({ "span": span, "merge": merge, "fill": fill, "blocks": blocks }));
            }
            rows.push(json!({ "cells": cells }));
        }
        if rows.is_empty() {
            return None;
        }
        Some(json!({ "type": "custom", "name": "table", "data": { "widths": widths, "rows": rows } }))
    }
}

fn decorate(text: String, f: &Fmt) -> Value {
    let plain = !(f.bold || f.italic || f.underline || f.strike || f.sup || f.sub || f.color.is_some() || f.highlight.is_some());
    if f.mono && plain {
        return json!({ "type": "code", "code": text });
    }
    // A coloured run is one node of its own (TextView has no text colour): its text and the
    // emphasis it keeps, for the app to draw as a span.
    if let Some(color) = &f.color {
        let node = json!({
            "type": "custom", "name": "color", "text": text,
            "data": { "color": color, "bold": f.bold, "italic": f.italic, "underline": f.underline, "strike": f.strike },
        });
        return match &f.highlight {
            Some(back) => json!({ "type": "highlight", "color": back, "content": [node] }),
            None => node,
        };
    }
    let mut node = json!({ "type": "text", "text": text });
    let wrap = |kind: &str, inner: Value| json!({ "type": kind, "content": [inner] });
    if f.sup {
        node = wrap("superscript", node);
    }
    if f.sub {
        node = wrap("subscript", node);
    }
    if f.strike {
        node = wrap("strikethrough", node);
    }
    if f.underline {
        node = wrap("underline", node);
    }
    if f.italic {
        node = wrap("emphasis", node);
    }
    if f.bold {
        node = wrap("strong", node);
    }
    if let Some(color) = &f.highlight {
        node = json!({ "type": "highlight", "color": color, "content": [node] });
    }
    node
}

/// The items from `at`, at `level` or deeper, as one `list` block (deeper ones nested in the
/// item before them); `at` moves past them.
fn build_list(items: &mut Vec<Item>, at: &mut usize, level: u32) -> Value {
    let ordered = items[*at].ordered;
    let start = items[*at].start;
    let mut out: Vec<Value> = Vec::new();
    while *at < items.len() && items[*at].level >= level {
        if items[*at].level > level {
            let deeper = items[*at].level;
            let nested = build_list(items, at, deeper);
            match out.last_mut() {
                Some(last) => last["children"].as_array_mut().expect("children").push(nested),
                None => out.push(json!({ "children": [nested] })),
            }
        } else if items[*at].ordered != ordered && !out.is_empty() {
            break;
        } else {
            out.push(json!({ "children": std::mem::take(&mut items[*at].blocks) }));
            *at += 1;
        }
    }
    let mut list = json!({ "type": "list", "ordered": ordered, "items": out });
    if ordered && start != 1 {
        list["start"] = json!(start);
    }
    list
}
