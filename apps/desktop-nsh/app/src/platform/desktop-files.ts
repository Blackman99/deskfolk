/**
 * `Files` (`deskfolk/native`) for `desktop-commands.ts`, which imports this module only when a
 * command comes: the bridge that answers them is in the app's entry, and a static import there
 * put all of `deskfolk/native` (PDF pages, code colours, the remote screen) into the engine every
 * page downloads before its first screen.
 */
export { Files } from "deskfolk/native";
