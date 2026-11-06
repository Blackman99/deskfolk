//! The terminal's colours: the app's card and ink for ground and text (brand direction A), an ANSI
//! palette tuned to sit on them, the 256-colour cube and grey ramp above the sixteen.

pub type Rgb = (u8, u8, u8);

const fn rgb(hex: u32) -> Rgb {
    ((hex >> 16) as u8, (hex >> 8) as u8, hex as u8)
}

pub struct Palette {
    pub foreground: Rgb,
    pub background: Rgb,
    pub cursor: Rgb,
    ansi: [Rgb; 16],
}

impl Palette {
    pub fn new(dark: bool) -> Palette {
        if dark {
            Palette {
                foreground: rgb(0xeef2f3),
                background: rgb(0x192125),
                cursor: rgb(0x45b0c3),
                ansi: [
                    rgb(0x2e393e), rgb(0xef6b6b), rgb(0x4ade80), rgb(0xfbbf24),
                    rgb(0x60a5fa), rgb(0xc084fc), rgb(0x45b0c3), rgb(0xc5cfd3),
                    rgb(0x5d6a70), rgb(0xf87171), rgb(0x86efac), rgb(0xfde68a),
                    rgb(0x93c5fd), rgb(0xd8b4fe), rgb(0x6cc3d2), rgb(0xffffff),
                ],
            }
        } else {
            Palette {
                foreground: rgb(0x121c20),
                background: rgb(0xffffff),
                cursor: rgb(0x146a7c),
                ansi: [
                    rgb(0x121c20), rgb(0xc62828), rgb(0x15803d), rgb(0xb45309),
                    rgb(0x1d4ed8), rgb(0x7e22ce), rgb(0x146a7c), rgb(0x5f6d74),
                    rgb(0x37444a), rgb(0xdc2626), rgb(0x16a34a), rgb(0xd97706),
                    rgb(0x2563eb), rgb(0x9333ea), rgb(0x0f8ba3), rgb(0x95a2a8),
                ],
            }
        }
    }

    /// The colour of `color`; `fallback` is what `Default` means where it is used.
    pub fn resolve(&self, color: vt100::Color, fallback: Rgb) -> Rgb {
        match color {
            vt100::Color::Default => fallback,
            vt100::Color::Rgb(r, g, b) => (r, g, b),
            vt100::Color::Idx(index) => self.indexed(index),
        }
    }

    fn indexed(&self, index: u8) -> Rgb {
        match index {
            0..=15 => self.ansi[index as usize],
            16..=231 => {
                let i = index - 16;
                let level = |v: u8| if v == 0 { 0 } else { 55 + v * 40 };
                (level(i / 36), level((i / 6) % 6), level(i % 6))
            }
            _ => {
                let v = 8 + (index - 232) * 10;
                (v, v, v)
            }
        }
    }
}

pub fn hex(c: Rgb) -> u32 {
    (c.0 as u32) << 16 | (c.1 as u32) << 8 | c.2 as u32
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn indexed_and_true_colours() {
        let palette = Palette::new(true);
        assert_eq!(palette.resolve(vt100::Color::Idx(1), (0, 0, 0)), rgb(0xef6b6b));
        assert_eq!(palette.resolve(vt100::Color::Idx(16), (9, 9, 9)), (0, 0, 0));
        assert_eq!(palette.resolve(vt100::Color::Idx(231), (9, 9, 9)), (255, 255, 255));
        assert_eq!(palette.resolve(vt100::Color::Idx(232), (9, 9, 9)), (8, 8, 8));
        assert_eq!(palette.resolve(vt100::Color::Rgb(1, 2, 3), (9, 9, 9)), (1, 2, 3));
        assert_eq!(palette.resolve(vt100::Color::Default, (9, 9, 9)), (9, 9, 9));
    }
}
