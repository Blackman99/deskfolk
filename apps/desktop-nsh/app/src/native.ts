/**
 * The shell's own native components (apps/desktop-nsh/native/*), registered on every window's
 * view before the bundle loads. They reach the runtime with the shell's own address and token, so
 * no secret crosses as a prop.
 */
import { nativeComponent } from "nsh";

export const Terminal = nativeComponent<
  { terminalId: string; fontSize?: number; dark?: boolean },
  { exit: { code: number | null }; error: { message: string }; size: { rows: number; cols: number } }
>("deskfolk.terminal", {
  props: ["terminalId", "fontSize", "dark"],
  events: ["exit", "error", "size"],
});

export const Pdf = nativeComponent<
  { path: string; background?: string },
  { loaded: { pages: number; firstLine: string }; error: { message: string } }
>("deskfolk.pdf", {
  props: ["path", "background"],
  events: ["loaded", "error"],
});
