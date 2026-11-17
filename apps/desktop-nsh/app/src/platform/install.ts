/**
 * Installs the browser globals the messenger's logic reads, and on a desktop the shell bridge to
 * the shell and the shell's wheel and press events; imported first, for its effect, before any
 * module of `src/m`.
 */
import { installGlobals } from "./globals";
import { installShellBridge } from "./shell-bridge";
import { installMedia } from "./media";
import { installPress } from "./press";
import { installWheel } from "./wheel";

installGlobals();
installShellBridge();
installWheel();
installPress();
installMedia();
