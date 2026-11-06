//! What a key sends to the pty: the bytes a VT terminal sends for AppKit's key commands
//! (`doCommandBySelector:`) and for Control chords.

/// The bytes for an AppKit text command, `None` for one a terminal ignores.
/// `app_cursor`: the program asked for application cursor keys (DECCKM).
pub fn command(selector: &str, app_cursor: bool) -> Option<&'static [u8]> {
    let arrow = |normal: &'static [u8], app: &'static [u8]| Some(if app_cursor { app } else { normal });
    match selector {
        "insertNewline:" | "insertLineBreak:" | "insertNewlineIgnoringFieldEditor:" => Some(b"\r"),
        "deleteBackward:" | "deleteBackwardByDecomposingPreviousCharacter:" => Some(b"\x7f"),
        "deleteForward:" => Some(b"\x1b[3~"),
        "insertTab:" | "insertTabIgnoringFieldEditor:" => Some(b"\t"),
        "insertBacktab:" => Some(b"\x1b[Z"),
        "cancelOperation:" => Some(b"\x1b"),
        "moveUp:" => arrow(b"\x1b[A", b"\x1bOA"),
        "moveDown:" => arrow(b"\x1b[B", b"\x1bOB"),
        "moveRight:" => arrow(b"\x1b[C", b"\x1bOC"),
        "moveLeft:" => arrow(b"\x1b[D", b"\x1bOD"),
        "moveWordLeft:" | "moveWordBackward:" => Some(b"\x1bb"),
        "moveWordRight:" | "moveWordForward:" => Some(b"\x1bf"),
        "moveToBeginningOfLine:" | "moveToLeftEndOfLine:" => Some(b"\x01"),
        "moveToEndOfLine:" | "moveToRightEndOfLine:" => Some(b"\x05"),
        "deleteWordBackward:" => Some(b"\x17"),
        "deleteToBeginningOfLine:" => Some(b"\x15"),
        "scrollToBeginningOfDocument:" | "moveToBeginningOfDocument:" => Some(b"\x1b[H"),
        "scrollToEndOfDocument:" | "moveToEndOfDocument:" => Some(b"\x1b[F"),
        "scrollPageUp:" | "pageUp:" => Some(b"\x1b[5~"),
        "scrollPageDown:" | "pageDown:" => Some(b"\x1b[6~"),
        _ => None,
    }
}

/// The byte a Control chord sends: Control-A is 0x01, Control-[ is Escape, Control-? is DEL.
pub fn control(character: char) -> Option<u8> {
    match character.to_ascii_lowercase() {
        c @ 'a'..='z' => Some(c as u8 - b'a' + 1),
        '@' | ' ' | '2' => Some(0),
        '[' | '3' => Some(0x1b),
        '\\' | '4' => Some(0x1c),
        ']' | '5' => Some(0x1d),
        '^' | '6' => Some(0x1e),
        '_' | '-' | '7' => Some(0x1f),
        '?' | '8' => Some(0x7f),
        _ => None,
    }
}

/// The bytes for AppKit's function-key characters (`NSF1FunctionKey` …), which reach a view as
/// characters rather than as commands.
pub fn function_key(character: char) -> Option<&'static [u8]> {
    Some(match character as u32 {
        0xF704 => b"\x1bOP",
        0xF705 => b"\x1bOQ",
        0xF706 => b"\x1bOR",
        0xF707 => b"\x1bOS",
        0xF708 => b"\x1b[15~",
        0xF709 => b"\x1b[17~",
        0xF70A => b"\x1b[18~",
        0xF70B => b"\x1b[19~",
        0xF70C => b"\x1b[20~",
        0xF70D => b"\x1b[21~",
        0xF70E => b"\x1b[23~",
        0xF70F => b"\x1b[24~",
        _ => return None,
    })
}

/// AppKit's private-use characters for keys (arrows, function keys): never text to send.
pub fn is_key_character(character: char) -> bool {
    (0xF700..=0xF8FF).contains(&(character as u32))
}

/// A paste, bracketed when the program asked for it (so a shell does not run it line by line).
pub fn paste(text: &str, bracketed: bool) -> Vec<u8> {
    // A pasted line break is a return, as in every terminal.
    let text = text.replace("\r\n", "\r").replace('\n', "\r");
    if bracketed {
        let clean = text.replace("\x1b[201~", "");
        [b"\x1b[200~".as_slice(), clean.as_bytes(), b"\x1b[201~"].concat()
    } else {
        text.into_bytes()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn arrows_follow_application_cursor_mode() {
        assert_eq!(command("moveUp:", false), Some(&b"\x1b[A"[..]));
        assert_eq!(command("moveUp:", true), Some(&b"\x1bOA"[..]));
        assert_eq!(command("moveLeft:", true), Some(&b"\x1bOD"[..]));
    }

    #[test]
    fn return_backspace_and_escape() {
        assert_eq!(command("insertNewline:", false), Some(&b"\r"[..]));
        assert_eq!(command("deleteBackward:", false), Some(&b"\x7f"[..]));
        assert_eq!(command("cancelOperation:", false), Some(&b"\x1b"[..]));
        assert_eq!(command("noop:", false), None);
    }

    #[test]
    fn control_chords() {
        assert_eq!(control('c'), Some(3));
        assert_eq!(control('C'), Some(3));
        assert_eq!(control('['), Some(0x1b));
        assert_eq!(control(' '), Some(0));
        assert_eq!(control('1'), None);
    }

    #[test]
    fn a_paste_is_bracketed_and_cannot_close_its_own_bracket() {
        assert_eq!(paste("ls\nrm -rf x\x1b[201~", true), b"\x1b[200~ls\rrm -rf x\x1b[201~".to_vec());
        assert_eq!(paste("a\r\nb", false), b"a\rb".to_vec());
    }
}
