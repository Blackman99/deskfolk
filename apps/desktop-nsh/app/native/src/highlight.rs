//! Code in the colours the messenger's Shiki paints it: VS Code's TextMate grammars and themes,
//! through giallo, which carries Shiki's own grammars and themes and tokenizes as VS Code does.
//! The editor, chat's code blocks and a command's output read as they did in 0.4.0, in
//! the app's code colours or in the ones your interface chose (ADR 0106).
//!
//! NSH's own highlighting (syntect with bat's Sublime syntaxes) folds every scope into eight kinds
//! with its own palette and takes no theme; against Shiki its grammars agree on 47–97% of the
//! characters depending on the language, and a 16 KB TSX file took 435 ms. giallo agrees on all of
//! them in TSX, Python, Rust and JSON, and takes 1–6 ms on the same files once warm.
//!
//! The registry (about 220 grammars and 60 themes, 1.4 MiB compressed) is read once. On the
//! desktops it is in the binary and is read, about 20 ms, on a thread of its own when the app asks
//! (`warm`); a call before then waits for it. The web build leaves it out: the page fetches it
//! (`nsh-giallo.<hash>.bin`, which `scripts/phone-package.ts` puts beside the runtime's files) and
//! reads it, after the frame that shows the code, the first time the app asks (`ready`). Until then
//! `available` is false there and code keeps NSH's colours; without the file it stays so.

use nsh_core::prelude::*;

mod engine {
    use std::cell::RefCell;
    use std::fmt::Write as _;
    use std::sync::OnceLock;

    use giallo::{FontStyle, HighlightOptions, Registry, ThemeVariant};
    use nsh_core::element::StyleRefinement;

    static REGISTRY: OnceLock<Option<Registry>> = OnceLock::new();

    /// The grammars and themes, read on the first call (which waits for them).
    #[cfg(not(target_arch = "wasm32"))]
    pub(super) fn registry() -> Option<&'static Registry> {
        REGISTRY
            .get_or_init(|| {
                let mut registry = Registry::builtin().ok()?;
                registry.link_grammars();
                Some(registry)
            })
            .as_ref()
    }

    /// The grammars and themes once [`ready`] has read the page's copy; none before.
    #[cfg(target_arch = "wasm32")]
    pub(super) fn registry() -> Option<&'static Registry> {
        REGISTRY.get().and_then(Option::as_ref)
    }

    #[cfg(not(target_arch = "wasm32"))]
    pub(super) fn warm() {
        if REGISTRY.get().is_none() {
            std::thread::spawn(|| {
                registry();
            });
        }
    }

    #[cfg(target_arch = "wasm32")]
    pub(super) fn warm() {}

    /// Whether code is coloured now: always on the desktops (a call waits for the registry), on
    /// the web once [`ready`] has read it.
    pub(super) fn usable() -> bool {
        cfg!(not(target_arch = "wasm32")) || registry().is_some()
    }

    #[cfg(not(target_arch = "wasm32"))]
    pub(super) async fn ready() -> Result<(), String> {
        warm();
        Ok(())
    }

    /// Fetches the page's copy of the registry (the runtime's data `giallo`) and reads it, once.
    #[cfg(target_arch = "wasm32")]
    pub(super) async fn ready() -> Result<(), String> {
        if let Some(read) = REGISTRY.get() {
            return read.as_ref().map(|_| ()).ok_or_else(|| "the page's code colours could not be read".to_owned());
        }
        // Reading it holds the page for a moment: not in the frame that shows the code.
        nsh_core::prelude::next_frame().await;
        let Some(bytes) = nsh_core::runtime_data::load("giallo").await else {
            let _ = REGISTRY.set(None);
            return Err("the page has no code colours (nsh-giallo.bin)".to_owned());
        };
        if REGISTRY.get().is_none() {
            let read = Registry::load(&bytes).map(|mut registry| {
                registry.link_grammars();
                registry
            });
            match read {
                Ok(registry) => {
                    let _ = REGISTRY.set(Some(registry));
                }
                Err(err) => {
                    let _ = REGISTRY.set(None);
                    return Err(format!("the page's code colours could not be read: {err}"));
                }
            }
        }
        registry().map(|_| ()).ok_or_else(|| "the page's code colours could not be read".to_owned())
    }

    /// A token's style as bits: 1 bold, 2 underline, 4 italic, 8 strikethrough.
    fn font_bits(style: FontStyle) -> u8 {
        [(FontStyle::BOLD, 1), (FontStyle::UNDERLINE, 2), (FontStyle::ITALIC, 4), (FontStyle::STRIKETHROUGH, 8)]
            .into_iter()
            .filter(|(flag, _)| style.contains(*flag))
            .map(|(_, bit)| bit)
            .sum()
    }

    /// Files known by their whole name rather than an extension.
    const NAMED: &[(&str, &str)] = &[
        ("dockerfile", "docker"),
        ("containerfile", "docker"),
        ("makefile", "make"),
        ("gnumakefile", "make"),
        ("cmakelists.txt", "cmake"),
        ("gemfile", "ruby"),
        ("rakefile", "ruby"),
        (".bashrc", "shellscript"),
        (".zshrc", "shellscript"),
        (".profile", "shellscript"),
        (".env", "dotenv"),
    ];

    /// Extensions that are no grammar's name or alias.
    const EXTENSIONS: &[(&str, &str)] = &[
        ("h", "c"),
        ("hh", "cpp"),
        ("hpp", "cpp"),
        ("hxx", "cpp"),
        ("cc", "cpp"),
        ("cxx", "cpp"),
        ("htm", "html"),
        ("xhtml", "html"),
        ("svg", "xml"),
        ("plist", "xml"),
        ("jsonc", "jsonc"),
        ("json5", "json5"),
        ("ndjson", "json"),
        ("jsonl", "jsonl"),
        ("mdx", "mdx"),
        ("markdown", "markdown"),
        ("pyi", "python"),
        ("pyw", "python"),
        ("ipynb", "json"),
        ("kts", "kotlin"),
        ("gradle", "groovy"),
        ("cs", "csharp"),
        ("fs", "fsharp"),
        ("ps1", "powershell"),
        ("psm1", "powershell"),
        ("cmd", "bat"),
        ("rb", "ruby"),
        ("ex", "elixir"),
        ("exs", "elixir"),
        ("erl", "erlang"),
        ("hs", "haskell"),
        ("ml", "ocaml"),
        ("pl", "perl"),
        ("pm", "perl"),
        ("tf", "terraform"),
        ("conf", "ini"),
        ("cfg", "ini"),
        ("lock", "toml"),
    ];

    /// The grammar for `language`: a name or alias (`ts`, `python`), a fence's info string
    /// (`rust title="main.rs"`), a file name (`main.go`, `Dockerfile`) or a path. `None`: plain.
    pub(super) fn grammar(registry: &Registry, language: &str) -> Option<String> {
        let word = language.split_whitespace().next().unwrap_or("").trim_start_matches('{').trim_end_matches('}');
        let lower = word.to_ascii_lowercase();
        if lower.is_empty() || matches!(lower.as_str(), "plain" | "text" | "txt" | "plaintext") {
            return None;
        }
        if registry.contains_grammar(&lower) {
            return Some(lower);
        }
        let name = lower.rsplit(['/', '\\']).next().unwrap_or(&lower);
        if let Some((_, grammar)) = NAMED.iter().find(|(file, _)| *file == name) {
            return registry.contains_grammar(grammar).then(|| (*grammar).to_owned());
        }
        let ext = name.rsplit_once('.').map(|(_, ext)| ext)?;
        if registry.contains_grammar(ext) {
            return Some(ext.to_owned());
        }
        let (_, grammar) = EXTENSIONS.iter().find(|(e, _)| *e == ext)?;
        registry.contains_grammar(grammar).then(|| (*grammar).to_owned())
    }

    /// The colours of `code` as JSON (see `Highlight::highlight`), or `""`.
    pub(super) fn highlight(code: &str, language: &str, theme: &str) -> String {
        let Some(registry) = registry() else { return String::new() };
        if !registry.contains_theme(theme) {
            return String::new();
        }
        let Some(lang) = grammar(registry, language) else { return String::new() };
        let options = HighlightOptions::new(&lang, ThemeVariant::Single(theme)).merge_whitespace(true).merge_same_style_tokens(true);
        let Ok(out) = registry.highlight(code, &options) else { return String::new() };
        let ThemeVariant::Single(compiled) = out.theme else { return String::new() };
        let plain = compiled.default_style;
        let mut colors: Vec<String> = Vec::new();
        let mut json = String::with_capacity(code.len() / 2);
        let _ = write!(json, "{{\"fg\":\"{}\",\"bg\":\"{}\",\"lines\":[", plain.foreground.as_hex(), plain.background.as_hex());
        for (n, line) in out.tokens.iter().enumerate() {
            if n > 0 {
                json.push(',');
            }
            json.push('[');
            let mut column = 0usize;
            let mut first = true;
            for token in line {
                let text = token.text.trim_end_matches(['\n', '\r']);
                let len = text.encode_utf16().count();
                let ThemeVariant::Single(style) = token.style else { continue };
                let bits = font_bits(style.font_style);
                if len > 0 && (style.foreground != plain.foreground || bits != 0) && !text.trim().is_empty() {
                    let hex = style.foreground.as_hex();
                    let index = colors.iter().position(|c| *c == hex).unwrap_or_else(|| {
                        colors.push(hex);
                        colors.len() - 1
                    });
                    if !first {
                        json.push(',');
                    }
                    first = false;
                    let _ = write!(json, "{},{},{},{}", column, column + len, index, bits);
                }
                column += len;
            }
            json.push(']');
        }
        json.push_str("],\"colors\":[");
        for (n, color) in colors.iter().enumerate() {
            if n > 0 {
                json.push(',');
            }
            let _ = write!(json, "\"{color}\"");
        }
        json.push_str("]}");
        json
    }

    fn rgba_of(hex: &str) -> u32 {
        let digits = hex.trim_start_matches('#');
        let value = u32::from_str_radix(digits, 16).unwrap_or(0);
        if digits.len() == 8 { value } else { (value << 8) | 0xff }
    }

    type BlockStyles = Vec<(std::ops::Range<usize>, StyleRefinement)>;

    /// How many blocks' styles are kept: more than a long reply has.
    const KEPT: usize = 32;

    thread_local! {
        /// The blocks coloured last, by language, themes and code: a reply's text view draws its
        /// blocks again for every word streamed into it, and on the web that is the page's thread.
        static BLOCKS: RefCell<Vec<((String, String, String, String), BlockStyles)>> = const { RefCell::new(Vec::new()) };
    }

    /// [`block_styles`] once per block: the styles kept from the last time it was coloured.
    pub(super) fn block_styles_kept(code: &str, language: &str, light_theme: &str, dark_theme: &str) -> BlockStyles {
        let key = (language.to_owned(), light_theme.to_owned(), dark_theme.to_owned(), code.to_owned());
        let kept = BLOCKS.with_borrow_mut(|blocks| {
            let at = blocks.iter().position(|(k, _)| *k == key)?;
            let entry = blocks.remove(at);
            let styles = entry.1.clone();
            blocks.push(entry);
            Some(styles)
        });
        if let Some(styles) = kept {
            return styles;
        }
        let styles = block_styles(code, language, light_theme, dark_theme);
        // Nothing yet (no registry, no such language) is not kept: the registry may come later.
        if !styles.is_empty() {
            BLOCKS.with_borrow_mut(|blocks| {
                if blocks.len() >= KEPT {
                    blocks.remove(0);
                }
                blocks.push((key, styles.clone()));
            });
        }
        styles
    }

    /// The styles of `code`'s byte ranges as `language` reads, in `light` and `dark` at once (each
    /// a Shiki theme): what `CodeColors` gives a text view's code block. Every token is coloured,
    /// the theme's own text colour too, as Shiki colours every span.
    pub(super) fn block_styles(code: &str, language: &str, light_theme: &str, dark_theme: &str) -> BlockStyles {
        use nsh_core::prelude::{AdaptiveColor, FontWeight, Styled as _, rgba};
        let Some(registry) = registry() else { return Vec::new() };
        if !registry.contains_theme(light_theme) || !registry.contains_theme(dark_theme) {
            return Vec::new();
        }
        let Some(lang) = grammar(registry, language) else { return Vec::new() };
        let options = HighlightOptions::new(&lang, ThemeVariant::Dual { light: light_theme, dark: dark_theme }).merge_whitespace(true).merge_same_style_tokens(true);
        let Ok(out) = registry.highlight(code, &options) else { return Vec::new() };
        let mut styles = Vec::new();
        let mut at = 0usize;
        for line in &out.tokens {
            for token in line {
                let start = at;
                at += token.text.len();
                if token.text.trim().is_empty() || code.get(start..at) != Some(token.text.as_str()) {
                    continue;
                }
                let ThemeVariant::Dual { light: lit, dark: dim } = token.style else { continue };
                let mut style = StyleRefinement::default().text_color(AdaptiveColor::new(rgba(rgba_of(&lit.foreground.as_hex())), rgba(rgba_of(&dim.foreground.as_hex()))));
                let font = font_bits(lit.font_style);
                if font & 1 != 0 {
                    style = style.font_weight(FontWeight::BOLD);
                }
                if font & 2 != 0 {
                    style = style.underline();
                }
                if font & 4 != 0 {
                    style = style.italic();
                }
                if font & 8 != 0 {
                    style = style.line_through();
                }
                styles.push((start..at, style));
            }
            // The line break between lines, when the tokens leave it out.
            if code[at.min(code.len())..].starts_with("\r\n") {
                at += 2;
            } else if code[at.min(code.len())..].starts_with('\n') {
                at += 1;
            }
        }
        styles
    }

    /// `"<bg> <fg>"` of `theme`, or `""`.
    pub(super) fn surface(theme: &str) -> String {
        let Some(registry) = registry() else { return String::new() };
        if !registry.contains_theme(theme) {
            return String::new();
        }
        let options = HighlightOptions::new("plain", ThemeVariant::Single(theme)).fallback_to_plain(true);
        let Ok(out) = registry.highlight("", &options) else { return String::new() };
        let ThemeVariant::Single(compiled) = out.theme else { return String::new() };
        format!("{} {}", compiled.default_style.background.as_hex(), compiled.default_style.foreground.as_hex())
    }
}

/// The props of [`CodeColors`].
#[derive(Debug, Clone, PartialEq, Props)]
pub struct CodeColorsProps {
    /// The Shiki theme of the code blocks in the light appearance.
    pub light: Prop<SharedString>,
    /// The Shiki theme of the code blocks in the dark appearance.
    pub dark: Prop<SharedString>,
    /// What it colours: the text views in it, made while it places them, so they find its colours.
    #[prop(lazy)]
    pub children: Prop<Children>,
}

/// The code blocks of the text views in it, coloured as the messenger's Shiki colours them in
/// `light` and `dark`, following the appearance (NSH's `CodeHighlighter`, given to the views below).
/// The themes are read as it is made: for others, make it again. Made before there are colours (the
/// web, before `Highlight.ready`) the blocks are plain: NSH's own colours would read syntaxes of their
/// own (another download, and at a language's first block a freeze of seconds on a slow phone) only to
/// be replaced a moment later. Where the colours never come, leave this out and NSH's apply.
#[component]
pub fn CodeColors(props: CodeColorsProps, _cx: Scope<NoEvent>) -> impl IntoElement {
    let light = props.light.get_untracked().to_string();
    let dark = props.dark.get_untracked().to_string();
    engine::warm();
    if engine::usable() {
        provide_context(nsh_base::CodeHighlighter::new(move |block| engine::block_styles_kept(&block.code, block.language.as_deref().unwrap_or(""), &light, &dark)));
    } else {
        provide_context(nsh_base::CodeHighlighter::new(|_| Vec::new()));
    }
    view().child(props.children)
}

/// Code coloured as the messenger's Shiki colours it.
#[module]
pub struct Highlight;

#[module]
impl Highlight {
    /// Whether code can be coloured now: on the desktops always, on the web once `ready` has
    /// resolved.
    pub fn available() -> bool {
        engine::usable()
    }

    /// Reads the grammars and themes on a thread of its own, so the first code shown does not wait.
    /// Nothing on the web: `ready` reads them there.
    pub fn warm() {
        engine::warm();
    }

    /// Resolves once code can be coloured. On the web it fetches the page's copy of the grammars
    /// and themes and reads it, the first time; it rejects when the page has none or it cannot be
    /// read (code then keeps NSH's colours). On the desktops it resolves at once.
    pub async fn ready() -> Result<(), String> {
        engine::ready().await
    }

    /// `code` read as `language` (a name, an alias, a fence's info string, a file name or a path)
    /// in `theme` (a Shiki theme's name), as JSON: `{"fg", "bg", "lines", "colors"}`. `lines` has
    /// one array per line of `code`, four numbers per run: its start and end in UTF-16 units of the
    /// line, its colour's index in `colors`, and its style (1 bold, 2 underline, 4 italic,
    /// 8 strikethrough). Runs in the theme's own text colour with no style are left out. `""` when
    /// the language or the theme is unknown.
    pub fn highlight(code: String, language: String, theme: String) -> String {
        engine::highlight(&code, &language, &theme)
    }

    /// `"<background> <text colour>"` of a Shiki theme, or `""` when it is unknown.
    pub fn surface(theme: String) -> String {
        engine::surface(&theme)
    }
}

#[cfg(all(test, not(target_arch = "wasm32")))]
mod tests {
    use super::engine;

    #[test]
    fn languages_are_found_by_name_alias_info_string_file_name_and_path() {
        let registry = engine::registry().expect("the built-in grammars");
        let found = |s: &str| engine::grammar(registry, s);
        assert_eq!(found("ts").as_deref(), Some("ts"));
        assert_eq!(found("TypeScript").as_deref(), Some("typescript"));
        assert_eq!(found("rust title=\"main.rs\"").as_deref(), Some("rust"));
        assert_eq!(found("src/main.go").as_deref(), Some("go"));
        assert_eq!(found("Dockerfile").as_deref(), Some("dockerfile"));
        assert_eq!(found("Makefile").as_deref(), Some("makefile"));
        assert_eq!(found("include/a.hpp").as_deref(), Some("cpp"));
        assert_eq!(found("App.tsx").as_deref(), Some("tsx"));
        assert_eq!(found(""), None);
        assert_eq!(found("text"), None);
        assert_eq!(found("notes.unknownext"), None);
    }

    #[test]
    fn a_keyword_has_githubs_colour_and_runs_count_utf16_units() {
        let json: serde_json::Value = serde_json::from_str(&engine::highlight("const 名 = \"x\";\nlet y = 1", "ts", "github-light")).unwrap();
        assert_eq!(json["fg"], "#24292E");
        let colors: Vec<String> = json["colors"].as_array().unwrap().iter().map(|c| c.as_str().unwrap().to_owned()).collect();
        let lines = json["lines"].as_array().unwrap();
        assert_eq!(lines.len(), 2);
        let first: Vec<u64> = lines[0].as_array().unwrap().iter().map(|v| v.as_u64().unwrap()).collect();
        // `const`: columns 0..5, GitHub's keyword red.
        assert_eq!(&first[..2], &[0, 5]);
        assert_eq!(colors[first[2] as usize], "#D73A49");
        // The string after a CJK name covers its UTF-16 column 10 (名 is one unit); white space
        // before a token joins it.
        let string = first.chunks(4).find(|run| colors[run[2] as usize] == "#032F62").unwrap();
        assert!(string[0] <= 10 && string[1] == 13);
    }

    #[test]
    fn an_unknown_language_or_theme_gives_nothing() {
        assert_eq!(engine::highlight("x", "notes.unknownext", "github-light"), "");
        assert_eq!(engine::highlight("x", "ts", "no-such-theme"), "");
        assert_eq!(engine::surface("no-such-theme"), "");
        assert_eq!(engine::surface("github-dark"), "#24292E #E1E4E8");
    }

    #[test]
    fn a_block_coloured_again_gets_the_styles_it_had() {
        let code = "const a = 1;\nconst b = 2;";
        let fresh = engine::block_styles(code, "ts", "github-light", "github-dark");
        let first = engine::block_styles_kept(code, "ts", "github-light", "github-dark");
        let again = engine::block_styles_kept(code, "ts", "github-light", "github-dark");
        let ranges = |styles: &[(std::ops::Range<usize>, nsh_core::element::StyleRefinement)]| styles.iter().map(|(range, _)| range.clone()).collect::<Vec<_>>();
        assert!(!fresh.is_empty());
        assert_eq!(ranges(&first), ranges(&fresh));
        assert_eq!(ranges(&again), ranges(&fresh));
        // Another language is another block.
        assert!(engine::block_styles_kept(code, "notes.unknownext", "github-light", "github-dark").is_empty());
    }

    #[test]
    fn a_blocks_styles_are_ranges_of_its_own_text_in_order() {
        let code = "fn main() {\n    let s = \"héllo\";\r\n    println!(\"{s}\");\n}";
        let styles = engine::block_styles(code, "rust", "github-light", "github-dark");
        assert!(!styles.is_empty());
        let mut at = 0;
        for (range, _) in &styles {
            assert!(range.start >= at && range.end > range.start && code.get(range.clone()).is_some());
            at = range.end;
        }
        assert!(styles.iter().any(|(range, _)| &code[range.clone()] == "fn"));
        assert!(styles.iter().any(|(range, _)| code[range.clone()].trim_start().starts_with("println")));
    }
}
