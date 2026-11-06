/**
 * What a desktop shell started this window with (`host.params`): the runtime's address and token
 * (also answered as the Tauri command `local_api_endpoint`) and the first window's development
 * checks (`--open-session`, `--pane`, `--pdf`, `--scroll-probe`, `--terminal`).
 */
import { host } from "nsh";

type Params = {
  origin: string;
  token: string;
  windowId: number;
  material: string;
  openSession: string;
  pane: string;
  pdfPath: string;
  scrollProbe: boolean;
  terminal: string;
};

const params = host.params as Partial<Params>;

export const windowId: number = params.windowId ?? 0;
export const glass: boolean = params.material === "glass";
export const initialSession: string | null = params.openSession ?? null;
export const initialPane: string | null = params.pane ?? null;
export const initialPdf: string = params.pdfPath ?? "";
export const scrollProbe: boolean = params.scrollProbe === true;
/** Development comparison: the macOS NSView terminal (`--terminal native`) instead of the canvas. */
export const nativeTerminal: boolean = params.terminal === "native";
