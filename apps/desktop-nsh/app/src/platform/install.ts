/**
 * Installs the browser globals the messenger's logic reads, and on a desktop the Tauri bridge to
 * the shell; imported first, for its effect, before any module of `src/m`.
 */
import { installGlobals } from "./globals";
import { installTauriBridge } from "./tauri-bridge";

installGlobals();
installTauriBridge();
