/**
 * The floor (ADR 0106): what you need to stay in charge must stay on screen whatever your interface
 * profile says — Stop, the buttons of a card waiting on you, the way to Settings and to undo a
 * change. Each is marked `data-floor="…"`. After the profile is applied, and whenever one of them
 * appears, each is checked: shown, solid enough, big enough, taking clicks, its words visible, and
 * not covered at its middle. A failure only counts when the profile is what causes it — checked
 * again with the profile's sheet off — so a button the app itself has folded away never trips it.
 */

export type FloorFailure = { floor: string; why: string };

export const FLOOR_SELECTOR = "[data-floor]";
const MIN_SIZE = 12;
const MIN_OPACITY = 0.6;
const MIN_TEXT_ALPHA = 0.4;

/** The alpha of a computed colour (`rgb(…)`, `rgba(…)`, `color(srgb … / a)`, `transparent`); 1 when unreadable. */
export function colorAlpha(color: string): number {
  const value = color.trim().toLowerCase();
  if (value === "transparent") return 0;
  const slash = value.match(/\/\s*([\d.]+)(%?)\s*\)$/);
  if (slash) return slash[2] ? Number(slash[1]) / 100 : Number(slash[1]);
  const rgba = value.match(/^rgba?\(([^)]*)\)$/);
  if (rgba) {
    const parts = rgba[1]!.split(",").map((part) => part.trim());
    if (parts.length === 4) return Number(parts[3]);
  }
  return 1;
}

function describe(el: Element): string {
  const hook = el.getAttribute("data-ui") ?? el.getAttribute("data-floor");
  if (hook) return `[${el.hasAttribute("data-ui") ? "data-ui" : "data-floor"}="${hook}"]`;
  const cls = typeof el.className === "string" ? el.className.trim().split(/\s+/).filter((name) => !name.startsWith("svelte-"))[0] : "";
  return `${el.tagName.toLowerCase()}${cls ? `.${cls}` : ""}`;
}

/** Why a floor element is not usable as things stand, or null. */
export function floorProblem(el: HTMLElement, win: Window = window): string | null {
  const style = win.getComputedStyle(el);
  if (style.display === "none") return "display: none";
  if (style.visibility === "hidden" || style.visibility === "collapse") return `visibility: ${style.visibility}`;
  if (style.pointerEvents === "none") return "pointer-events: none";
  let opacity = 1;
  for (let node: Element | null = el; node; node = node.parentElement) {
    const raw = win.getComputedStyle(node).opacity;
    const own = raw === "" ? 1 : Number(raw);
    if (Number.isFinite(own)) opacity *= own;
  }
  if (opacity < MIN_OPACITY) return `opacity ${opacity.toFixed(2)}`;
  const rect = el.getBoundingClientRect();
  if (rect.width < MIN_SIZE || rect.height < MIN_SIZE) return `size ${Math.round(rect.width)}×${Math.round(rect.height)}`;
  if ((el.textContent ?? "").trim() && colorAlpha(style.color) < MIN_TEXT_ALPHA) return "its words are transparent";
  const inView = rect.bottom > 0 && rect.right > 0 && rect.top < win.innerHeight && rect.left < win.innerWidth;
  if (inView && typeof win.document.elementFromPoint === "function") {
    const x = Math.min(Math.max(rect.left + rect.width / 2, 0), win.innerWidth - 1);
    const y = Math.min(Math.max(rect.top + rect.height / 2, 0), win.innerHeight - 1);
    const hit = win.document.elementFromPoint(x, y);
    if (hit && hit !== el && !el.contains(hit)) return `covered by ${describe(hit)}`;
  }
  return null;
}

/** Every floor element on the page that is not usable now. */
export function floorFailures(root: ParentNode = document, win: Window = window): Array<FloorFailure & { el: HTMLElement }> {
  const out: Array<FloorFailure & { el: HTMLElement }> = [];
  for (const el of root.querySelectorAll<HTMLElement>(FLOOR_SELECTOR)) {
    const why = floorProblem(el, win);
    if (why) out.push({ el, floor: el.dataset.floor ?? "", why });
  }
  return out;
}

/**
 * The floors your profile hides: those failing with its sheet on that pass with it off. `setOn`
 * switches the sheet; it is left on afterwards.
 */
export function floorsHiddenByProfile(setOn: (on: boolean) => void, root: ParentNode = document, win: Window = window): FloorFailure[] {
  const failing = floorFailures(root, win);
  if (failing.length === 0) return [];
  setOn(false);
  try {
    return failing.filter(({ el }) => el.isConnected && floorProblem(el, win) === null).map(({ floor, why }) => ({ floor, why }));
  } finally {
    setOn(true);
  }
}
