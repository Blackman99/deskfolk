/**
 * Installs the browser globals the messenger's logic reads, and on a desktop the Tauri bridge to
 * the shell and the shell's wheel and press events; imported first, for its effect, before any
 * module of `src/m`.
 */
import { installGlobals } from "./globals";
import { installTauriBridge } from "./tauri-bridge";
import { installMedia } from "./media";
import { installPress } from "./press";
import { installWheel } from "./wheel";

installGlobals();
installTauriBridge();
installWheel();
installPress();
installMedia();
