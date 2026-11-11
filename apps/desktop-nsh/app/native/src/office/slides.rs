//! PowerPoint (pptx): every slide as shapes in z-order (the master's and the layout's own shapes
//! first, then the slide's) with their frames in points, fills, lines, text and pictures.
//! Placeholders take their frame, text body properties and list styles from the slide layout and
//! the master where the slide leaves them out; text takes its sizes, bullets and colours from the
//! master's `txStyles`; `schemeClr` goes through the colour map and the theme.
//!
//! Not drawn: charts, SmartArt, media, WordArt effects, gradients (the first stop stands in),
//! shadows, arrowheads, picture crops and effects, custom geometry outlines, rotation of groups,
//! table styles beyond a header and banded rows, speaker notes and animations.

use std::collections::HashMap;
use std::rc::Rc;

use serde_json::{Value, json};

use super::archive::{Package, related, relationships};
use super::color::Palette;
use super::xml::Node;

const EMU: f64 = 12700.0;
const MAX_SLIDES: usize = 500;

fn pt(emu: f64) -> f64 {
    (emu / EMU * 100.0).round() / 100.0
}

#[derive(Clone, Copy)]
struct Tf {
    ox: f64,
    oy: f64,
    sx: f64,
    sy: f64,
}

#[derive(Clone, Default)]
struct Lvl {
    size: Option<f64>,
    bold: Option<bool>,
    italic: Option<bool>,
    underline: Option<bool>,
    strike: Option<bool>,
    color: Option<String>,
    algn: Option<String>,
    mar_l: Option<f64>,
    indent: Option<f64>,
    bullet: Option<Bu>,
    before: Option<f64>,
    line: Option<f64>,
}

#[derive(Clone)]
enum Bu {
    None,
    Char(String),
    Auto(String, u32),
}

impl Lvl {
    fn rpr(&mut self, r: &Node, pal: &Palette) {
        if let Some(sz) = r.num("sz") {
            self.size = Some(sz / 100.0);
        }
        if let Some(b) = r.attr("b") {
            self.bold = Some(b == "1" || b == "true");
        }
        if let Some(i) = r.attr("i") {
            self.italic = Some(i == "1" || i == "true");
        }
        if let Some(u) = r.attr("u") {
            self.underline = Some(u != "none");
        }
        if let Some(s) = r.attr("strike") {
            self.strike = Some(s != "noStrike");
        }
        if let Some(fill) = r.child("solidFill") {
            if let Some(c) = pal.colour(fill, None) {
                self.color = Some(c);
            }
        }
    }

    fn ppr(&mut self, p: &Node, pal: &Palette) {
        if let Some(a) = p.attr("algn") {
            self.algn = Some(a.to_string());
        }
        if let Some(m) = p.num("marL") {
            self.mar_l = Some(pt(m));
        }
        if let Some(i) = p.num("indent") {
            self.indent = Some(pt(i));
        }
        for c in &p.children {
            match c.name.as_str() {
                "lnSpc" => {
                    if let Some(v) = c.child("spcPct").and_then(|s| s.num("val")) {
                        self.line = Some(v / 100000.0);
                    }
                }
                "spcBef" => {
                    if let Some(v) = c.child("spcPts").and_then(|s| s.num("val")) {
                        self.before = Some(v / 100.0);
                    } else if let Some(v) = c.child("spcPct").and_then(|s| s.num("val")) {
                        self.before = Some(-(v / 100000.0));
                    }
                }
                "buNone" => self.bullet = Some(Bu::None),
                "buChar" => {
                    if let Some(ch) = c.attr("char") {
                        self.bullet = Some(Bu::Char(ch.to_string()));
                    }
                }
                "buAutoNum" => self.bullet = Some(Bu::Auto(c.attr("type").unwrap_or("arabicPeriod").to_string(), c.num("startAt").unwrap_or(1.0) as u32)),
                "defRPr" => self.rpr(c, pal),
                _ => {}
            }
        }
    }
}

struct Ph {
    ty: Option<String>,
    idx: Option<String>,
}

fn ph_of(shape: &Node) -> Option<Ph> {
    let ph = shape.children.iter().find_map(|c| c.child("nvPr")).and_then(|n| n.child("ph"))?;
    Some(Ph { ty: ph.attr("type").map(String::from), idx: ph.attr("idx").map(String::from) })
}

/// The master's kind of a placeholder: titles, text, and the footer ones by their own type.
fn family(ty: Option<&str>) -> &str {
    match ty {
        Some("title" | "ctrTitle") => "title",
        None | Some("body" | "obj" | "subTitle" | "tbl" | "chart" | "pic" | "media" | "clipArt" | "dgm") => "body",
        Some(other) => other,
    }
}

fn find_ph<'a>(tree: &'a Node, ph: &Ph, by_idx: bool) -> Option<&'a Node> {
    let shapes = tree.children.iter().filter(|c| matches!(c.name.as_str(), "sp" | "pic"));
    let mut by_type = None;
    for s in shapes {
        let Some(other) = ph_of(s) else { continue };
        if by_idx && ph.idx.is_some() && other.idx == ph.idx {
            return Some(s);
        }
        if by_type.is_none() && family(other.ty.as_deref()) == family(ph.ty.as_deref()) && (by_idx || other.idx == ph.idx || other.idx.is_none() || ph.idx.is_none() || family(ph.ty.as_deref()) != "body") {
            by_type = Some(s);
        }
    }
    by_type
}

struct Deck<'a> {
    pkg: &'a mut Package,
    parts: HashMap<String, Rc<Node>>,
}

impl Deck<'_> {
    fn part(&mut self, name: &str) -> Option<Rc<Node>> {
        if let Some(p) = self.parts.get(name) {
            return Some(p.clone());
        }
        let node = Rc::new(self.pkg.xml(name)?);
        self.parts.insert(name.to_string(), node.clone());
        Some(node)
    }
}

/// What one slide is drawn with.
struct Scope {
    pal: Palette,
    slide: Rc<Node>,
    layout: Option<Rc<Node>>,
    master: Option<Rc<Node>>,
    default_style: Option<Rc<Node>>,
    lines: Vec<f64>,
    layout_rels: HashMap<String, (String, bool)>,
    master_rels: HashMap<String, (String, bool)>,
    slide_rels: HashMap<String, (String, bool)>,
}

#[derive(Clone, Copy, PartialEq)]
enum From {
    Slide,
    Layout,
    Master,
}

pub fn read(pkg: &mut Package) -> Result<Value, String> {
    let mut deck = Deck { pkg, parts: HashMap::new() };
    const MAIN: &str = "ppt/presentation.xml";
    let pres = deck.part(MAIN).ok_or(super::archive::INVALID)?;
    let rels = relationships(deck.pkg, MAIN);
    let size = pres.child("sldSz");
    let (w, h) = (size.and_then(|s| s.num("cx")).unwrap_or(9144000.0), size.and_then(|s| s.num("cy")).unwrap_or(6858000.0));
    let default_style = pres.child("defaultTextStyle").map(|n| Rc::new(n.clone()));
    let mut slides = Vec::new();
    let ids: Vec<&str> = pres.child("sldIdLst").map(|l| l.kids("sldId").filter_map(|s| s.attr("r:id")).collect()).unwrap_or_default();
    let truncated = ids.len() > MAX_SLIDES;
    for id in ids.into_iter().take(MAX_SLIDES) {
        let Some((path, false)) = rels.get(id) else { continue };
        let Some(slide) = deck.part(path) else { continue };
        let layout_path = related(deck.pkg, path, "/slideLayout");
        let layout = layout_path.as_deref().and_then(|p| deck.part(p));
        let master_path = layout_path.as_deref().and_then(|p| related(deck.pkg, p, "/slideMaster"));
        let master = master_path.as_deref().and_then(|p| deck.part(p));
        let theme_path = master_path.as_deref().and_then(|p| related(deck.pkg, p, "/theme"));
        let theme = theme_path.as_deref().and_then(|p| deck.part(p));
        let pal = Palette::new(theme.as_deref(), master.as_deref());
        let lines = theme
            .as_ref()
            .and_then(|t| t.find("lnStyleLst"))
            .map(|l| l.kids("ln").map(|n| n.num("w").unwrap_or(12700.0)).collect())
            .unwrap_or_default();
        let scope = Scope {
            pal,
            slide: slide.clone(),
            layout,
            master,
            default_style: default_style.clone(),
            lines,
            layout_rels: layout_path.as_deref().map(|p| relationships(deck.pkg, p)).unwrap_or_default(),
            master_rels: master_path.as_deref().map(|p| relationships(deck.pkg, p)).unwrap_or_default(),
            slide_rels: relationships(deck.pkg, path),
        };
        slides.push(scope.slide_json());
    }
    Ok(json!({ "kind": "presentation", "width": pt(w), "height": pt(h), "slides": slides, "truncated": truncated }))
}

impl Scope {
    fn tree(node: &Node) -> Option<&Node> {
        node.child("cSld")?.child("spTree")
    }

    fn slide_json(&self) -> Value {
        let slide = self.slide.clone();
        let show_master = slide.attr("showMasterSp") != Some("0");
        let layout_shows_master = self.layout.as_ref().is_none_or(|l| l.attr("showMasterSp") != Some("0"));
        let tf = Tf { ox: 0.0, oy: 0.0, sx: 1.0, sy: 1.0 };
        let mut shapes = Vec::new();
        if show_master && layout_shows_master {
            if let Some(tree) = self.master.as_deref().and_then(Self::tree) {
                self.shapes(tree, From::Master, tf, &mut shapes);
            }
        }
        if show_master {
            if let Some(tree) = self.layout.as_deref().and_then(Self::tree) {
                self.shapes(tree, From::Layout, tf, &mut shapes);
            }
        }
        if let Some(tree) = Self::tree(&slide) {
            self.shapes(tree, From::Slide, tf, &mut shapes);
        }
        json!({ "background": self.background(), "shapes": shapes })
    }

    fn background(&self) -> Option<String> {
        for part in [Some(&self.slide), self.layout.as_ref(), self.master.as_ref()].into_iter().flatten() {
            let Some(bg) = part.child("cSld").and_then(|c| c.child("bg")) else { continue };
            if let Some(pr) = bg.child("bgPr") {
                if let Some(c) = self.fill_of(pr, None, None) {
                    return Some(c);
                }
            }
            if let Some(r) = bg.child("bgRef") {
                if let Some(c) = self.pal.colour(r, None) {
                    return Some(c);
                }
            }
        }
        None
    }

    fn rels(&self, from: From) -> &HashMap<String, (String, bool)> {
        match from {
            From::Slide => &self.slide_rels,
            From::Layout => &self.layout_rels,
            From::Master => &self.master_rels,
        }
    }

    fn shapes(&self, tree: &Node, from: From, tf: Tf, out: &mut Vec<Value>) {
        for node in &tree.children {
            match node.name.as_str() {
                "sp" | "pic" | "cxnSp" => {
                    // The layout's and the master's placeholders are prompts, not drawing.
                    if from != From::Slide && ph_of(node).is_some() {
                        continue;
                    }
                    self.shape(node, from, tf, out);
                }
                "grpSp" => {
                    let Some(x) = node.child("grpSpPr").and_then(|p| p.child("xfrm")) else { continue };
                    let (off, ext, ch_off, ch_ext) = (x.child("off"), x.child("ext"), x.child("chOff"), x.child("chExt"));
                    let n = |e: Option<&Node>, a: &str| e.and_then(|e| e.num(a)).unwrap_or(0.0);
                    let gx = if n(ch_ext, "cx") > 0.0 { n(ext, "cx") / n(ch_ext, "cx") } else { 1.0 };
                    let gy = if n(ch_ext, "cy") > 0.0 { n(ext, "cy") / n(ch_ext, "cy") } else { 1.0 };
                    let inner = Tf {
                        sx: tf.sx * gx,
                        sy: tf.sy * gy,
                        ox: tf.ox + tf.sx * (n(off, "x") - n(ch_off, "x") * gx),
                        oy: tf.oy + tf.sy * (n(off, "y") - n(ch_off, "y") * gy),
                    };
                    self.shapes(node, from, inner, out);
                }
                "graphicFrame" => self.frame(node, from, tf, out),
                _ => {}
            }
        }
    }

    /// The nodes a shape inherits from, the shape first.
    fn chain<'a>(&'a self, node: &'a Node, from: From) -> Vec<&'a Node> {
        let mut chain = vec![node];
        if from != From::Slide {
            return chain;
        }
        if let Some(ph) = ph_of(node) {
            let layout = self.layout.as_deref().and_then(Self::tree).and_then(|t| find_ph(t, &ph, true));
            if let Some(l) = layout {
                chain.push(l);
            }
            let layout_ph = layout.and_then(ph_of);
            let key = layout_ph.as_ref().unwrap_or(&ph);
            if let Some(m) = self.master.as_deref().and_then(Self::tree).and_then(|t| find_ph(t, key, false)) {
                chain.push(m);
            }
        }
        chain
    }

    fn frame_of(&self, chain: &[&Node], tf: Tf) -> Option<(f64, f64, f64, f64, f64, bool, bool)> {
        for n in chain {
            let Some(x) = n.child("spPr").and_then(|p| p.child("xfrm")) else { continue };
            let (Some(off), Some(ext)) = (x.child("off"), x.child("ext")) else { continue };
            let (ox, oy) = (off.num("x")?, off.num("y")?);
            let (w, h) = (ext.num("cx")?, ext.num("cy")?);
            return Some((
                pt(tf.ox + ox * tf.sx),
                pt(tf.oy + oy * tf.sy),
                pt(w * tf.sx),
                pt(h * tf.sy),
                x.num("rot").unwrap_or(0.0) / 60000.0,
                x.attr("flipH") == Some("1"),
                x.attr("flipV") == Some("1"),
            ));
        }
        None
    }

    fn fill_of(&self, sppr: &Node, style: Option<&Node>, ph: Option<&str>) -> Option<String> {
        for c in &sppr.children {
            match c.name.as_str() {
                "noFill" => return None,
                "solidFill" => return self.pal.colour(c, ph),
                "gradFill" => return c.find("gs").and_then(|g| self.pal.colour(g, ph)),
                _ => {}
            }
        }
        let r = style?.child("fillRef")?;
        if r.num("idx").unwrap_or(0.0) == 0.0 {
            return None;
        }
        self.pal.colour(r, None)
    }

    fn line_of(&self, chain: &[&Node], style: Option<&Node>) -> Option<Value> {
        for n in chain {
            let Some(ln) = n.child("spPr").and_then(|p| p.child("ln")) else { continue };
            if ln.child("noFill").is_some() {
                return None;
            }
            let width = ln.num("w").unwrap_or(12700.0);
            let color = ln.child("solidFill").and_then(|f| self.pal.colour(f, None)).or_else(|| style.and_then(|s| s.child("lnRef")).and_then(|r| self.pal.colour(r, None)));
            if let Some(color) = color {
                return Some(json!({ "color": color, "width": pt(width).max(0.25), "dash": ln.child("prstDash").and_then(|d| d.attr("val")) }));
            }
        }
        let r = style?.child("lnRef")?;
        let idx = r.num("idx").unwrap_or(0.0) as usize;
        if idx == 0 {
            return None;
        }
        let width = self.lines.get(idx - 1).copied().unwrap_or(12700.0);
        Some(json!({ "color": self.pal.colour(r, None)?, "width": pt(width).max(0.25) }))
    }

    fn shape(&self, node: &Node, from: From, tf: Tf, out: &mut Vec<Value>) {
        let chain = self.chain(node, from);
        let Some((x, y, w, h, rot, flip_h, flip_v)) = self.frame_of(&chain, tf) else { return };
        let style = node.child("style");
        let sppr = node.child("spPr");
        let prst = chain.iter().find_map(|n| n.child("spPr").and_then(|p| p.child("prstGeom")).and_then(|g| g.attr("prst"))).unwrap_or(if node.child("spPr").is_some_and(|p| p.child("custGeom").is_some()) { "custom" } else { "rect" });
        let mut shape = json!({ "type": "shape", "x": x, "y": y, "w": w, "h": h, "rot": rot, "flipH": flip_h, "flipV": flip_v, "geom": prst });
        let rels = self.rels(from);
        if node.name == "pic" {
            let embed = node.child("blipFill").and_then(|b| b.child("blip")).and_then(|b| b.attr("r:embed"));
            let Some((part, false)) = embed.and_then(|e| rels.get(e)) else { return };
            shape["type"] = json!("picture");
            shape["src"] = json!(format!("office-image:{part}"));
            if let Some(alt) = node.find("cNvPr").and_then(|c| c.attr("descr")).filter(|a| !a.is_empty()) {
                shape["alt"] = json!(alt);
            }
            if let Some(line) = self.line_of(&chain, style) {
                shape["line"] = line;
            }
            out.push(shape);
            return;
        }
        if node.name == "cxnSp" || matches!(prst, "line" | "straightConnector1") {
            shape["geom"] = json!("line");
        }
        let ph = ph_of(node);
        if let Some(sppr) = chain.iter().filter_map(|n| n.child("spPr")).find(|p| p.children.iter().any(|c| matches!(c.name.as_str(), "noFill" | "solidFill" | "gradFill"))).or(sppr) {
            if let Some(fill) = self.fill_of(sppr, style, None) {
                shape["fill"] = json!(fill);
            }
        } else if let Some(fill) = style.and_then(|s| self.fill_of(&Node::default(), Some(s), None)) {
            shape["fill"] = json!(fill);
        }
        if let Some(line) = self.line_of(&chain, style) {
            shape["line"] = line;
        }
        if let Some(body) = node.child("txBody") {
            let text = self.text(body, &chain, ph.as_ref(), style, None);
            if !text["paragraphs"].as_array().is_some_and(|p| p.is_empty()) {
                shape["text"] = text;
            }
        }
        if shape.get("fill").is_none() && shape.get("line").is_none() && shape.get("text").is_none() {
            return;
        }
        out.push(shape);
    }

    /// A text body: its paragraphs resolved against the list styles above it.
    fn text(&self, body: &Node, chain: &[&Node], ph: Option<&Ph>, style: Option<&Node>, fixed_scale: Option<f64>) -> Value {
        let body_pr = |attr: &str| chain.iter().find_map(|n| n.child("txBody").and_then(|b| b.child("bodyPr")).and_then(|b| b.attr(attr)));
        let inset = |attr: &str, default: f64| pt(body_pr(attr).and_then(|v| v.parse().ok()).unwrap_or(default));
        let scale = fixed_scale.unwrap_or_else(|| {
            chain
                .iter()
                .find_map(|n| n.child("txBody").and_then(|b| b.child("bodyPr")).and_then(|b| b.child("normAutofit")))
                .and_then(|a| a.num("fontScale"))
                .map(|s| s / 100000.0)
                .unwrap_or(1.0)
        });
        let base: Option<Rc<Node>> = match ph.map(|p| family(p.ty.as_deref())) {
            Some("title") => self.master.as_ref().and_then(|m| m.child("txStyles")).and_then(|t| t.child("titleStyle")).map(|n| Rc::new(n.clone())),
            Some("body") => self.master.as_ref().and_then(|m| m.child("txStyles")).and_then(|t| t.child("bodyStyle")).map(|n| Rc::new(n.clone())),
            Some(_) => self.master.as_ref().and_then(|m| m.child("txStyles")).and_then(|t| t.child("otherStyle")).map(|n| Rc::new(n.clone())),
            None => self.default_style.clone(),
        };
        let font_color = style.and_then(|s| s.child("fontRef")).and_then(|r| self.pal.colour(r, None));
        let lst: Vec<&Node> = chain.iter().rev().filter_map(|n| n.child("txBody").and_then(|b| b.child("lstStyle"))).collect();
        let mut counters: Vec<u32> = vec![0; 10];
        let mut paragraphs = Vec::new();
        for p in body.kids("p") {
            let ppr = p.child("pPr");
            let level = ppr.and_then(|n| n.num("lvl")).unwrap_or(0.0).clamp(0.0, 8.0) as usize;
            let key = format!("lvl{}pPr", level + 1);
            let mut lvl = Lvl { color: font_color.clone(), ..Lvl::default() };
            if let Some(b) = &base {
                if let Some(n) = b.child(&key) {
                    lvl.ppr(n, &self.pal);
                }
            }
            for l in &lst {
                if let Some(n) = l.child(&key) {
                    lvl.ppr(n, &self.pal);
                }
            }
            if let Some(n) = ppr {
                lvl.ppr(n, &self.pal);
            }
            let mut runs = Vec::new();
            for r in &p.children {
                let mut run = lvl.clone();
                if let Some(rp) = r.child("rPr") {
                    run.rpr(rp, &self.pal);
                }
                let text = match r.name.as_str() {
                    "r" | "fld" => r.child("t").map(|t| t.text.clone()).unwrap_or_default(),
                    "br" => "\n".to_string(),
                    _ => continue,
                };
                if text.is_empty() {
                    continue;
                }
                runs.push(json!({
                    "text": text,
                    "size": ((run.size.unwrap_or(18.0) * scale) * 100.0).round() / 100.0,
                    "bold": run.bold.unwrap_or(false),
                    "italic": run.italic.unwrap_or(false),
                    "underline": run.underline.unwrap_or(false),
                    "strike": run.strike.unwrap_or(false),
                    "color": run.color.clone().unwrap_or_else(|| "#000000".into()),
                }));
            }
            let end_size = p.child("endParaRPr").and_then(|e| e.num("sz")).map(|s| s / 100.0).or(lvl.size).unwrap_or(18.0);
            let size = (lvl.size.unwrap_or(end_size) * scale * 100.0).round() / 100.0;
            // A bullet shows only on a paragraph with text; numbers count the run at one level.
            counters.iter_mut().skip(level + 1).for_each(|c| *c = 0);
            let bullet = if runs.is_empty() {
                None
            } else {
                match &lvl.bullet {
                    Some(Bu::Char(c)) => Some(bullet_char(c)),
                    Some(Bu::Auto(kind, start)) => {
                        counters[level] += 1;
                        Some(auto_number(kind, start + counters[level] - 1))
                    }
                    _ => {
                        counters[level] = 0;
                        None
                    }
                }
            };
            let before = lvl.before.map(|b| if b < 0.0 { -b * size * 1.2 } else { b }).unwrap_or(0.0);
            paragraphs.push(json!({
                "align": lvl.algn.clone().unwrap_or_else(|| "l".into()),
                "bullet": bullet,
                "marL": lvl.mar_l.unwrap_or(0.0),
                "indent": lvl.indent.unwrap_or(0.0),
                "before": (before * 100.0).round() / 100.0,
                "line": lvl.line,
                "size": size,
                "color": lvl.color.clone().unwrap_or_else(|| "#000000".into()),
                "runs": runs,
            }));
        }
        // Empty paragraphs at the end are spacing nobody sees.
        while paragraphs.last().is_some_and(|p: &Value| p["runs"].as_array().is_some_and(|r| r.is_empty())) {
            paragraphs.pop();
        }
        json!({
            "anchor": body_pr("anchor").unwrap_or("t"),
            "insets": [inset("lIns", 91440.0), inset("tIns", 45720.0), inset("rIns", 91440.0), inset("bIns", 45720.0)],
            "wrap": body_pr("wrap") != Some("none"),
            "paragraphs": paragraphs,
        })
    }

    /// A table: each cell becomes a shape with its own frame, fill and text.
    fn frame(&self, node: &Node, from: From, tf: Tf, out: &mut Vec<Value>) {
        let Some(tbl) = node.find("tbl") else { return };
        let Some(x) = node.child("xfrm") else { return };
        let (Some(off), Some(_)) = (x.child("off"), x.child("ext")) else { return };
        let (ox, oy) = (tf.ox + off.num("x").unwrap_or(0.0) * tf.sx, tf.oy + off.num("y").unwrap_or(0.0) * tf.sy);
        let cols: Vec<f64> = tbl.child("tblGrid").map(|g| g.kids("gridCol").map(|c| c.num("w").unwrap_or(0.0)).collect()).unwrap_or_default();
        let props = tbl.child("tblPr");
        let first_row = props.and_then(|p| p.attr("firstRow")) == Some("1");
        let banded = props.and_then(|p| p.attr("bandRow")) == Some("1");
        let rows: Vec<&Node> = tbl.kids("tr").collect();
        let heights: Vec<f64> = rows.iter().map(|r| r.num("h").unwrap_or(0.0)).collect();
        let accent = self.pal.theme.get("accent1").cloned();
        let tint = |amount: f64| {
            accent.as_ref().map(|a| {
                let c = |i: usize| u8::from_str_radix(&a[i..i + 2], 16).unwrap_or(0) as f64;
                let mix = |v: f64| (v * amount + 255.0 * (1.0 - amount)).round() as u8;
                format!("#{:02x}{:02x}{:02x}", mix(c(0)), mix(c(2)), mix(c(4)))
            })
        };
        let mut y = oy;
        for (ri, row) in rows.iter().enumerate() {
            let mut cx = ox;
            let mut col = 0usize;
            for cell in row.kids("tc") {
                let span = cell.num("gridSpan").unwrap_or(1.0).max(1.0) as usize;
                let row_span = cell.num("rowSpan").unwrap_or(1.0).max(1.0) as usize;
                let width: f64 = cols.iter().skip(col).take(span).sum();
                let continued = cell.attr("hMerge") == Some("1") || cell.attr("vMerge") == Some("1");
                if !continued {
                    let height: f64 = heights.iter().skip(ri).take(row_span).sum();
                    let header = first_row && ri == 0;
                    let pr = cell.child("tcPr");
                    let explicit = pr.and_then(|p| p.child("solidFill")).and_then(|f| self.pal.colour(f, None));
                    let fill = explicit.or_else(|| if header { accent.as_ref().map(|a| format!("#{a}")) } else if banded && ri % 2 == 1 { tint(0.2) } else if banded { tint(0.4) } else { None });
                    let mut shape = json!({
                        "type": "shape", "geom": "rect", "rot": 0, "flipH": false, "flipV": false,
                        "x": pt(cx * 1.0), "y": pt(y), "w": pt(width * tf.sx), "h": pt(height * tf.sy),
                        "line": { "color": "#ffffff", "width": 1 },
                    });
                    if let Some(fill) = fill {
                        shape["fill"] = json!(fill);
                    }
                    if let Some(body) = cell.child("txBody") {
                        let mut text = self.text(body, &[], None, None, None);
                        if header {
                            for p in text["paragraphs"].as_array_mut().into_iter().flatten() {
                                for r in p["runs"].as_array_mut().into_iter().flatten() {
                                    r["bold"] = json!(true);
                                    if shape.get("fill").is_some() && r["color"] == "#000000" {
                                        r["color"] = json!("#ffffff");
                                    }
                                }
                            }
                        }
                        text["anchor"] = json!("ctr");
                        let (l, t, r, b) = (pt(pr.and_then(|p| p.num("marL")).unwrap_or(91440.0)), pt(pr.and_then(|p| p.num("marT")).unwrap_or(45720.0)), pt(pr.and_then(|p| p.num("marR")).unwrap_or(91440.0)), pt(pr.and_then(|p| p.num("marB")).unwrap_or(45720.0)));
                        text["insets"] = json!([l, t, r, b]);
                        if !text["paragraphs"].as_array().is_some_and(|p| p.is_empty()) {
                            shape["text"] = text;
                        }
                    }
                    let _ = from;
                    out.push(shape);
                }
                cx += width * tf.sx;
                col += span;
            }
            y += heights[ri] * tf.sy;
        }
    }
}

fn bullet_char(c: &str) -> String {
    match c {
        "§" => "▪".into(),
        "Ø" => "➢".into(),
        "ü" => "✓".into(),
        "·" | "" => "•".into(),
        other => other.to_string(),
    }
}

fn auto_number(kind: &str, n: u32) -> String {
    let alpha = |upper: bool| {
        let c = (b'a' + ((n.max(1) - 1) % 26) as u8) as char;
        if upper { c.to_ascii_uppercase() } else { c }.to_string()
    };
    let roman = |upper: bool| {
        let mut n = n;
        let mut s = String::new();
        for (v, r) in [(1000, "m"), (900, "cm"), (500, "d"), (400, "cd"), (100, "c"), (90, "xc"), (50, "l"), (40, "xl"), (10, "x"), (9, "ix"), (5, "v"), (4, "iv"), (1, "i")] {
            while n >= v {
                s.push_str(r);
                n -= v;
            }
        }
        if upper { s.to_uppercase() } else { s }
    };
    let (label, tail) = match kind {
        k if k.starts_with("alphaLc") => (alpha(false), k),
        k if k.starts_with("alphaUc") => (alpha(true), k),
        k if k.starts_with("romanLc") => (roman(false), k),
        k if k.starts_with("romanUc") => (roman(true), k),
        k => (n.to_string(), k),
    };
    if tail.ends_with("ParenBoth") {
        format!("({label})")
    } else if tail.ends_with("ParenR") {
        format!("{label})")
    } else {
        format!("{label}.")
    }
}
