//! CLI parsing for `real-bot-pty --rows R --cols C --cwd DIR -- <command> [args...]`.
//!
//! Kept free of any Windows-only types so it can be unit tested on any host. The forgiving
//! handling of `--rows`/`--cols` (fall back to the default instead of erroring) matches the
//! Swift original's `UInt16(...) ?? default`, not a Rust idiom of our own choosing.

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Options {
    pub rows: u16,
    pub cols: u16,
    pub cwd: String,
    pub command: Vec<String>,
}

pub const DEFAULT_ROWS: u16 = 24;
pub const DEFAULT_COLS: u16 = 80;

/// Parses everything after argv\[0\]. `default_cwd` is used when `--cwd` is absent — the
/// process's own current directory at start-up, passed in so this function stays pure and
/// testable without touching the filesystem.
pub fn parse(args: &[String], default_cwd: &str) -> Result<Options, String> {
    let mut rows = DEFAULT_ROWS;
    let mut cols = DEFAULT_COLS;
    let mut cwd = default_cwd.to_string();
    let mut command: Vec<String> = Vec::new();

    let mut i = 0;
    while i < args.len() {
        match args[i].as_str() {
            "--rows" => {
                i += 1;
                rows = args.get(i).and_then(|s| s.parse().ok()).unwrap_or(DEFAULT_ROWS);
            }
            "--cols" => {
                i += 1;
                cols = args.get(i).and_then(|s| s.parse().ok()).unwrap_or(DEFAULT_COLS);
            }
            "--cwd" => {
                i += 1;
                if let Some(value) = args.get(i) {
                    cwd = value.clone();
                }
            }
            "--" => {
                command = args[i + 1..].to_vec();
                i = args.len();
                continue;
            }
            other => return Err(format!("unknown argument {other}")),
        }
        i += 1;
    }

    if command.is_empty() {
        return Err("no command".to_string());
    }
    Ok(Options { rows, cols, cwd, command })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(items: &[&str]) -> Vec<String> {
        items.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn parses_flags_and_command() {
        let options = parse(&args(&["--rows", "40", "--cols", "120", "--cwd", "C:\\ws", "--", "pwsh.exe", "-NoLogo"]), "C:\\default").unwrap();
        assert_eq!(options, Options {
            rows: 40,
            cols: 120,
            cwd: "C:\\ws".to_string(),
            command: vec!["pwsh.exe".to_string(), "-NoLogo".to_string()],
        });
    }

    #[test]
    fn defaults_rows_cols_cwd_when_absent() {
        let options = parse(&args(&["--", "cmd.exe"]), "C:\\default").unwrap();
        assert_eq!(options.rows, DEFAULT_ROWS);
        assert_eq!(options.cols, DEFAULT_COLS);
        assert_eq!(options.cwd, "C:\\default");
        assert_eq!(options.command, vec!["cmd.exe".to_string()]);
    }

    #[test]
    fn falls_back_to_default_on_unparsable_rows() {
        let options = parse(&args(&["--rows", "not-a-number", "--", "cmd.exe"]), "C:\\default").unwrap();
        assert_eq!(options.rows, DEFAULT_ROWS);
    }

    #[test]
    fn falls_back_to_default_when_rows_value_missing() {
        // `--rows` as the very last argument before nothing at all: no command follows either,
        // so this should fail on "no command", not panic on an out-of-bounds index.
        let err = parse(&args(&["--rows"]), "C:\\default").unwrap_err();
        assert_eq!(err, "no command");
    }

    #[test]
    fn keeps_default_cwd_when_value_missing() {
        let options = parse(&args(&["--cwd"]), "C:\\default");
        // No value and nothing else follows: cwd keeps its default, and the missing command is
        // what actually fails parsing (matching the Swift original, which never treats a
        // missing flag value as an error by itself).
        assert_eq!(options.unwrap_err(), "no command");
    }

    #[test]
    fn cwd_consumes_the_very_next_argument_even_if_it_looks_like_a_flag() {
        // `--cwd` unconditionally takes whatever token is next, exactly like the Swift
        // original — including `--` itself, which then can't also serve as the command
        // separator. This looks surprising but matches on purpose.
        let err = parse(&args(&["--cwd", "--", "cmd.exe"]), "C:\\default").unwrap_err();
        assert_eq!(err, "unknown argument cmd.exe");
    }

    #[test]
    fn unknown_argument_is_rejected() {
        let err = parse(&args(&["--bogus", "--", "cmd.exe"]), "C:\\default").unwrap_err();
        assert_eq!(err, "unknown argument --bogus");
    }

    #[test]
    fn empty_command_after_double_dash_is_rejected() {
        let err = parse(&args(&["--"]), "C:\\default").unwrap_err();
        assert_eq!(err, "no command");
    }

    #[test]
    fn missing_double_dash_is_rejected() {
        let err = parse(&args(&["pwsh.exe"]), "C:\\default").unwrap_err();
        assert_eq!(err, "unknown argument pwsh.exe");
    }

    #[test]
    fn flags_after_double_dash_are_part_of_the_command() {
        let options = parse(&args(&["--", "cmd.exe", "--rows", "999"]), "C:\\default").unwrap();
        assert_eq!(options.command, vec!["cmd.exe".to_string(), "--rows".to_string(), "999".to_string()]);
    }
}
