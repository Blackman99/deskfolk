/**
 * `deskfolk/native`'s `Highlight`, for `code-colors.tsx`, which imports this module the first time
 * something shows code (and at start on the desktops, to warm the grammars). `code-colors.tsx` is in
 * what the app loads at start (`Main.tsx`, a command's output); a static import there brought all of
 * `deskfolk/native` (PDF pages, Office files, the remote screen) before the phone's first screen.
 */
export { Highlight } from "deskfolk/native";
