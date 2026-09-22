import { expect, test } from "bun:test";
import { MOBILE_PAGE_MS, MOBILE_PAGE_OFFSET, pageSlide } from "./mobile-page-slide.ts";

function withMedia(matches: (query: string) => boolean, run: () => void): void {
  const previous = window.matchMedia;
  window.matchMedia = ((query: string) => ({
    matches: matches(query),
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  })) as typeof window.matchMedia;
  try {
    run();
  } finally {
    window.matchMedia = previous;
  }
}

const phone = (query: string) => query === "(max-width: 680px)";

test("a page arrives from the right and leaves the way it came", () => {
  withMedia(phone, () => {
    const slide = pageSlide(document.createElement("div"));
    expect(slide.duration).toBe(MOBILE_PAGE_MS);
    // One path, walked forwards on the way in and backwards on the way out: Svelte runs t from
    // 0 to 1 entering and from 1 to 0 leaving, so Back is the reverse of entering by construction.
    expect(slide.css(0)).toBe(`transform: translateX(${MOBILE_PAGE_OFFSET.toFixed(3)}%)`);
    expect(slide.css(0.5)).toBe(`transform: translateX(${(MOBILE_PAGE_OFFSET / 2).toFixed(3)}%)`);
    expect(slide.css(1)).toBe("transform: translateX(0.000%)");
  });
});

test("wider windows and reduced motion leave the page where the stylesheet put it", () => {
  withMedia(() => false, () => {
    const wide = pageSlide(document.createElement("div"));
    expect(wide.duration).toBe(0);
    expect(wide.css(0)).toBe("");
  });
  withMedia((query) => phone(query) || query === "(prefers-reduced-motion: reduce)", () => {
    const still = pageSlide(document.createElement("div"));
    expect(still.duration).toBe(0);
    expect(still.css(0)).toBe("");
  });
});
