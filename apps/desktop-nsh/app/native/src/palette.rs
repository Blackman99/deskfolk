//! The terminal's colours: the app's card and ink for ground and text (brand direction A), and an
//! ANSI palette tuned to sit on them. The 256-colour cube, the greys and 24-bit colours are drawn as
//! the program asks (`nsh_terminal.rs`).

pub type Rgb = (u8, u8, u8);

const fn rgb(hex: u32) -> Rgb {
    ((hex >> 16) as u8, (hex >> 8) as u8, hex as u8)
}

pub struct Palette {
    pub foreground: Rgb,
    pub background: Rgb,
    ansi: [Rgb; 16],
}

impl Palette {
    pub fn new(dark: bool) -> Palette {
        if dark {
            Palette {
                foreground: rgb(0xeef2f3),
                background: rgb(0x192125),
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
                ansi: [
                    rgb(0x121c20), rgb(0xc62828), rgb(0x15803d), rgb(0xb45309),
                    rgb(0x1d4ed8), rgb(0x7e22ce), rgb(0x146a7c), rgb(0x5f6d74),
                    rgb(0x37444a), rgb(0xdc2626), rgb(0x16a34a), rgb(0xd97706),
                    rgb(0x2563eb), rgb(0x9333ea), rgb(0x0f8ba3), rgb(0x95a2a8),
                ],
            }
        }
    }

    /// ANSI colour `index` (0–15) of this palette.
    pub fn ansi(&self, index: u8) -> Rgb {
        self.ansi[index as usize]
    }
}

pub fn hex(c: Rgb) -> u32 {
    (c.0 as u32) << 16 | (c.1 as u32) << 8 | c.2 as u32
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_sixteen_and_their_hex() {
        let dark = Palette::new(true);
        assert_eq!(dark.ansi(1), rgb(0xef6b6b));
        assert_eq!(dark.ansi(15), rgb(0xffffff));
        assert_eq!(Palette::new(false).ansi(1), rgb(0xc62828));
        assert_eq!(hex(dark.background), 0x192125);
    }
}
