import { afterEach, expect, test } from "bun:test";
import { MODAL_OUT_MS, modalOut } from "./modal-motion.ts";

const realMatchMedia = window.matchMedia;
const realAgent = navigator.userAgent;

function world({ phone = false, reduced = false }: { phone?: boolean; reduced?: boolean }): void {
  window.matchMedia = ((query: string) => ({
    matches: (query === "(max-width: 680px)" && phone) || (query === "(prefers-reduced-motion: reduce)" && reduced),
    media: query,
    addEventListener() {},
    removeEventListener() {},
  })) as unknown as typeof window.matchMedia;
  Object.defineProperty(navigator, "userAgent", { configurable: true, value: "Mozilla/5.0 (Macintosh) AppleWebKit/605.1.15" });
}

afterEach(() => {
  window.matchMedia = realMatchMedia;
  Object.defineProperty(navigator, "userAgent", { configurable: true, value: realAgent });
});

test("on a wider window a dialog fades out with its backdrop", () => {
  world({});
  const out = modalOut(document.createElement("div"));
  expect(out.duration).toBe(MODAL_OUT_MS);
  expect(out.css(0.5)).toBe("opacity: 0.500");
});

test("reduced motion closes it at once", () => {
  world({ reduced: true });
  expect(modalOut(document.createElement("div")).duration).toBe(0);
});

test("on a phone it walks back out the way a page does, or stays put when instant", () => {
  world({ phone: true });
  expect(modalOut(document.createElement("div")).css(0.5)).toContain("translateX");
  expect(modalOut(document.createElement("div"), { instant: true }).duration).toBe(0);
});

test("the component tests' DOM closes it at once", () => {
  expect(modalOut(document.createElement("div")).duration).toBe(0);
});
