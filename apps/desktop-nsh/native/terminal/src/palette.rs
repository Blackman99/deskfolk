//! The terminal's colours: the app's card and ink for the ground and text (brand direction A,
//! `tokens.css`), an ANSI palette tuned to sit on them, and what a program set by OSC on top.

use alacritty_terminal::term::color::Colors;
use alacritty_terminal::vte::ansi::{Color, NamedColor, Rgb};

const fn rgb(hex: u32) -> Rgb {
    Rgb { r: (hex >> 16) as u8, g: (hex >> 8) as u8, b: hex as u8 }
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

    /// The colour `color` stands for, with what the program set (`overrides`) first.
    pub fn resolve(&self, color: Color, overrides: &Colors) -> Rgb {
        match color {
            Color::Spec(rgb) => rgb,
            Color::Named(name) => overrides[name].unwrap_or_else(|| self.named(name)),
            Color::Indexed(index) => overrides[index as usize].unwrap_or_else(|| self.indexed(index)),
        }
    }

    fn named(&self, name: NamedColor) -> Rgb {
        match name {
            NamedColor::Foreground | NamedColor::BrightForeground => self.foreground,
            NamedColor::Background => self.background,
            NamedColor::Cursor => self.cursor,
            NamedColor::DimForeground => dim(self.foreground),
            other => {
                let index = other as usize;
                if index < 16 {
                    self.ansi[index]
                } else if (NamedColor::DimBlack as usize..=NamedColor::DimWhite as usize).contains(&index) {
                    dim(self.ansi[index - NamedColor::DimBlack as usize])
                } else {
                    self.foreground
                }
            }
        }
    }

    /// The 256-colour cube and grey ramp above the sixteen.
    fn indexed(&self, index: u8) -> Rgb {
        match index {
            0..=15 => self.ansi[index as usize],
            16..=231 => {
                let i = index - 16;
                let level = |v: u8| if v == 0 { 0 } else { 55 + v * 40 };
                Rgb { r: level(i / 36), g: level((i / 6) % 6), b: level(i % 6) }
            }
            _ => {
                let v = 8 + (index - 232) * 10;
                Rgb { r: v, g: v, b: v }
            }
        }
    }
}

fn dim(c: Rgb) -> Rgb {
    Rgb { r: (c.r as u16 * 2 / 3) as u8, g: (c.g as u16 * 2 / 3) as u8, b: (c.b as u16 * 2 / 3) as u8 }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn named_indexed_and_spec_colours() {
        let palette = Palette::new(true);
        let none = Colors::default();
        assert_eq!(palette.resolve(Color::Named(NamedColor::Background), &none), rgb(0x192125));
        assert_eq!(palette.resolve(Color::Named(NamedColor::Red), &none), rgb(0xef6b6b));
        assert_eq!(palette.resolve(Color::Indexed(1), &none), rgb(0xef6b6b));
        assert_eq!(palette.resolve(Color::Indexed(16), &none), rgb(0x000000));
        assert_eq!(palette.resolve(Color::Indexed(231), &none), rgb(0xffffff));
        assert_eq!(palette.resolve(Color::Indexed(232), &none), rgb(0x080808));
        assert_eq!(palette.resolve(Color::Spec(rgb(0x123456)), &none), rgb(0x123456));
    }

    #[test]
    fn what_the_program_set_wins() {
        let palette = Palette::new(false);
        let mut set = Colors::default();
        set[NamedColor::Foreground] = Some(rgb(0xaabbcc));
        assert_eq!(palette.resolve(Color::Named(NamedColor::Foreground), &set), rgb(0xaabbcc));
    }
}
