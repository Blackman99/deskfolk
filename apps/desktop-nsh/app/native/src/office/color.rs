//! DrawingML colours: `srgbClr`, `sysClr`, `prstClr` and `schemeClr` (through the master's colour
//! map and the theme), with the transforms decks actually use (`lumMod`, `lumOff`, `tint`,
//! `shade`, `alpha`).

use std::collections::HashMap;

use super::xml::Node;

pub struct Palette {
    /// `dk1`, `lt1`, `accent1`… → `rrggbb`.
    pub theme: HashMap<String, String>,
    /// `bg1` → `lt1`, `tx1` → `dk1`…
    pub map: HashMap<String, String>,
}

impl Palette {
    pub fn new(theme: Option<&Node>, master: Option<&Node>) -> Palette {
        let mut colors = HashMap::new();
        if let Some(scheme) = theme.and_then(|t| t.find("clrScheme")) {
            for c in &scheme.children {
                let Some(inner) = c.children.first() else { continue };
                let hex = match inner.name.as_str() {
                    "srgbClr" => inner.attr("val"),
                    "sysClr" => inner.attr("lastClr"),
                    _ => None,
                };
                if let Some(hex) = hex {
                    colors.insert(c.name.clone(), hex.to_ascii_lowercase());
                }
            }
        }
        let mut map: HashMap<String, String> = [("bg1", "lt1"), ("tx1", "dk1"), ("bg2", "lt2"), ("tx2", "dk2")]
            .iter()
            .map(|(a, b)| (a.to_string(), b.to_string()))
            .collect();
        if let Some(m) = master.and_then(|m| m.child("clrMap")) {
            for (k, v) in &m.attrs {
                map.insert(k.clone(), v.clone());
            }
        }
        Palette { theme: colors, map }
    }

    /// The colour a `solidFill`-like node holds in its first child, as `#rrggbb` (`#rrggbbaa` when
    /// transparent); `ph` is what `phClr` stands for.
    pub fn colour(&self, holder: &Node, ph: Option<&str>) -> Option<String> {
        let c = holder.children.first()?;
        let base = match c.name.as_str() {
            "srgbClr" => c.attr("val")?.to_ascii_lowercase(),
            "sysClr" => c.attr("lastClr").or(c.attr("val"))?.to_ascii_lowercase(),
            "prstClr" => preset(c.attr("val")?)?.to_string(),
            "schemeClr" => {
                let name = c.attr("val")?;
                if name == "phClr" {
                    ph?.trim_start_matches('#').to_string()
                } else {
                    let slot = self.map.get(name).map(String::as_str).unwrap_or(name);
                    self.theme.get(slot).or_else(|| self.theme.get(name))?.clone()
                }
            }
            _ => return None,
        };
        if base.len() != 6 {
            return None;
        }
        let mut rgb = [0usize, 2, 4].map(|i| u8::from_str_radix(&base[i..i + 2], 16).unwrap_or(0) as f64 / 255.0);
        let mut alpha = 1.0;
        for t in &c.children {
            let v = t.num("val").unwrap_or(0.0) / 100000.0;
            match t.name.as_str() {
                "lumMod" | "lumOff" => {
                    let (h, s, l) = to_hsl(rgb);
                    let l = if t.name == "lumMod" { l * v } else { l + v };
                    rgb = from_hsl(h, s, l.clamp(0.0, 1.0));
                }
                "tint" => rgb = rgb.map(|x| x * v + (1.0 - v)),
                "shade" => rgb = rgb.map(|x| x * v),
                "alpha" => alpha = v,
                _ => {}
            }
        }
        let [r, g, b] = rgb.map(|x| (x.clamp(0.0, 1.0) * 255.0).round() as u8);
        Some(if alpha < 0.999 { format!("#{r:02x}{g:02x}{b:02x}{:02x}", (alpha * 255.0).round() as u8) } else { format!("#{r:02x}{g:02x}{b:02x}") })
    }
}

fn preset(name: &str) -> Option<&'static str> {
    Some(match name {
        "black" => "000000",
        "white" => "ffffff",
        "red" => "ff0000",
        "green" => "008000",
        "blue" => "0000ff",
        "yellow" => "ffff00",
        "gray" | "grey" => "808080",
        "orange" => "ffa500",
        _ => return None,
    })
}

fn to_hsl([r, g, b]: [f64; 3]) -> (f64, f64, f64) {
    let max = r.max(g).max(b);
    let min = r.min(g).min(b);
    let l = (max + min) / 2.0;
    if (max - min).abs() < 1e-9 {
        return (0.0, 0.0, l);
    }
    let d = max - min;
    let s = if l > 0.5 { d / (2.0 - max - min) } else { d / (max + min) };
    let h = if max == r {
        (g - b) / d + if g < b { 6.0 } else { 0.0 }
    } else if max == g {
        (b - r) / d + 2.0
    } else {
        (r - g) / d + 4.0
    };
    (h / 6.0, s, l)
}

fn from_hsl(h: f64, s: f64, l: f64) -> [f64; 3] {
    if s == 0.0 {
        return [l, l, l];
    }
    let q = if l < 0.5 { l * (1.0 + s) } else { l + s - l * s };
    let p = 2.0 * l - q;
    let hue = |mut t: f64| {
        if t < 0.0 {
            t += 1.0;
        }
        if t > 1.0 {
            t -= 1.0;
        }
        if t < 1.0 / 6.0 {
            p + (q - p) * 6.0 * t
        } else if t < 0.5 {
            q
        } else if t < 2.0 / 3.0 {
            p + (q - p) * (2.0 / 3.0 - t) * 6.0
        } else {
            p
        }
    };
    [hue(h + 1.0 / 3.0), hue(h), hue(h - 1.0 / 3.0)]
}
