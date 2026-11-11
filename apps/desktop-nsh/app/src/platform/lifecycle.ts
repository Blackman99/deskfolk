/**
 * How the app is in use, as NSH's `lifecycle()` says it: `active` (the window has the focus),
 * `inactive` (shown without it), `background` (hidden or minimised). NSH 0.4's web player has no
 * `lifecycle` in the `nsh` module the app imports (its page reports one to the engine, but the
 * app's realm never gets it), so on the web `lifecycle()` threw and the conversation's reading
 * effect never ran. There it is read here from the page, as the messenger reads
 * `document.visibilityState` and `document.hasFocus()`: the app runs in a hidden same-origin frame
 * that never gets a focus or blur of its own (ADR 0107, Phase 1c), so the page's window and
 * document are the ones asked and listened to. Everywhere else it is NSH's own.
 */
import { lifecycle as nshLifecycle, signal, type Accessor } from "nsh";

type Phase = "active" | "inactive" | "background";
type PageDocument = { visibilityState?: string; hasFocus(): boolean; addEventListener(type: string, listener: () => void): void };
export type PageWindow = { document?: PageDocument; addEventListener(type: string, listener: () => void): void };

/** The page the app is shown in: the frame's parent when it is one of the page's, else this realm's own window. */
function page(): PageWindow | null {
  const realm = globalThis as unknown as PageWindow & { parent?: PageWindow };
  try {
    if (realm.parent?.document) return realm.parent;
  } catch {
    // A parent of another origin: only this realm's own document can be asked.
  }
  return realm.document ? realm : null;
}

/** `lifecycle()` read from page `shown` and kept current as it gains or loses the focus, hides or shows. */
export function pageLifecycle(shown: PageWindow | null = page()): Accessor<Phase> {
  const doc = shown?.document;
  if (!shown || !doc) return () => "active";
  const read = (): Phase => (doc.visibilityState === "hidden" ? "background" : doc.hasFocus() ? "active" : "inactive");
  const phase = signal<Phase>(read());
  const update = () => phase.set(read());
  for (const type of ["focus", "blur", "pageshow", "pagehide"]) shown.addEventListener(type, update);
  doc.addEventListener("visibilitychange", update);
  return phase;
}

export const lifecycle: Accessor<Phase> = typeof nshLifecycle === "function" ? nshLifecycle : pageLifecycle();
