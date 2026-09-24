import { afterEach, expect, test } from "bun:test";
import {
  CONTENT_WIDTH_MAX,
  VIEWPORT_DEVICES,
  VIEWPORT_SIZE,
  fitViewport,
  loadViewportDevice,
  pageLayoutWidth,
  saveViewportDevice,
  viewportHelperMarkup,
  viewportMeta,
  viewportMessage,
} from "./html-viewport.ts";

afterEach(() => {
  window.localStorage.removeItem("real-bot-html-viewport");
});

test("the page keeps the device's own viewport whatever the pane's size; only the scale changes", () => {
  for (const device of VIEWPORT_DEVICES) {
    for (const avail of [
      { width: 300, height: 400 },
      { width: 900, height: 700 },
      { width: 4000, height: 3000 },
    ]) {
      const layout = fitViewport(device, avail);
      expect({ width: layout.width, height: layout.height }).toEqual(VIEWPORT_SIZE[device]);
      expect(layout.screen.width).toBeCloseTo(layout.width * layout.scale, 6);
      expect(layout.screen.height).toBeCloseTo(layout.height * layout.scale, 6);
    }
  }
});

test("the whole device, bezel and laptop base included, fits the space it is given", () => {
  for (const device of VIEWPORT_DEVICES) {
    for (const avail of [
      { width: 360, height: 900 },
      { width: 1200, height: 420 },
      { width: 700, height: 700 },
    ]) {
      const { frame } = fitViewport(device, avail);
      expect(frame.width).toBeLessThanOrEqual(avail.width + 1e-6);
      expect(frame.height).toBeLessThanOrEqual(avail.height + 1e-6);
      // And it is as large as it can be: one side touches.
      const touches = Math.abs(frame.width - avail.width) < 1e-6 || Math.abs(frame.height - avail.height) < 1e-6;
      expect(touches).toBe(true);
    }
  }
});

test("a pane larger than the device shows it at its real size, not blown up", () => {
  const layout = fitViewport("phone", { width: 2000, height: 2000 });
  expect(layout.scale).toBe(1);
  expect(layout.screen).toEqual({ width: 390, height: 844 });
  expect(layout.frame.width).toBeGreaterThan(390);
});

test("the laptop's base reaches past its lid; tablets and phones have none", () => {
  const laptop = fitViewport("desktop", { width: 900, height: 900 });
  expect(laptop.overhang).toBeGreaterThan(0);
  expect(laptop.base).toBeGreaterThan(0);
  expect(laptop.frame.width).toBeCloseTo(laptop.screen.width + 2 * laptop.bezel.side + 2 * laptop.overhang, 6);
  for (const device of ["tablet", "phone"] as const) {
    const layout = fitViewport(device, { width: 900, height: 900 });
    expect(layout.overhang).toBe(0);
    expect(layout.base).toBe(0);
  }
});

test("a pane with no size yet still gets a drawable device", () => {
  const layout = fitViewport("desktop", { width: 0, height: 0 });
  expect(layout.scale).toBeGreaterThan(0);
  expect(Number.isFinite(layout.frame.width)).toBe(true);
});

test("the picked device is remembered, and anything else reads as the laptop", () => {
  expect(loadViewportDevice()).toBe("desktop");
  saveViewportDevice("phone");
  expect(loadViewportDevice()).toBe("phone");
  window.localStorage.setItem("real-bot-html-viewport", "watch");
  expect(loadViewportDevice()).toBe("desktop");
});

const CH = "0123456789abcdef0123456789abcdef";

test("the viewport tag is read the way a browser reads it", () => {
  expect(viewportMeta("<html><head><title>x</title></head></html>")).toBeNull();
  expect(viewportMeta('<meta name="viewport" content="width=device-width, initial-scale=1">')).toEqual({
    width: "device-width",
    initialScale: 1,
  });
  expect(viewportMeta("<meta content='width=1080' name=viewport>")).toEqual({ width: 1080, initialScale: null });
  expect(viewportMeta('<meta name="viewport" content="initial-scale=0.5; user-scalable=no">')).toEqual({
    width: null,
    initialScale: 0.5,
  });
  // A commented-out tag is not there; neither is a meta that only mentions the word.
  expect(viewportMeta('<!-- <meta name="viewport" content="width=device-width"> -->')).toBeNull();
  expect(viewportMeta('<meta name="viewport-fit" content="cover">')).toBeNull();
});

test("a desktop lays every page out at its window; a phone or tablet goes by the page's viewport tag", () => {
  const mobile = { width: "device-width" as const, initialScale: 1 };
  expect(pageLayoutWidth("desktop", mobile)).toBe(1440);
  expect(pageLayoutWidth("desktop", null, 3000)).toBe(1440);
  expect(pageLayoutWidth("phone", mobile)).toBe(390);
  expect(pageLayoutWidth("tablet", mobile)).toBe(820);
  expect(pageLayoutWidth("phone", { width: 1080, initialScale: null })).toBe(1080);
  expect(pageLayoutWidth("phone", { width: null, initialScale: 0.5 })).toBe(780);
  expect(pageLayoutWidth("phone", { width: null, initialScale: null })).toBe(980);
  // No tag at all: 980, or the content's width when it is wider, never past the cap.
  expect(pageLayoutWidth("phone", null)).toBe(980);
  expect(pageLayoutWidth("phone", null, 600)).toBe(980);
  expect(pageLayoutWidth("phone", null, 1079.4)).toBe(1080);
  expect(pageLayoutWidth("tablet", null, 1e9)).toBe(CONTENT_WIDTH_MAX);
});

test("a page laid out wider than the device is drawn smaller, filling the same screen", () => {
  const own = fitViewport("phone", { width: 800, height: 900 });
  expect(own.page).toEqual({ width: 390, height: 844, scale: own.scale });
  const wide = fitViewport("phone", { width: 800, height: 900 }, 1080);
  expect(wide.page.width).toBe(1080);
  expect(wide.page.width * wide.page.scale).toBeCloseTo(wide.screen.width, 6);
  expect(wide.page.height * wide.page.scale).toBeCloseTo(wide.screen.height, 6);
  // The device itself does not change with the page.
  expect(wide.frame).toEqual(own.frame);
});

test("the helper hides scrollbars only on touch devices and carries the nonce", () => {
  const phone = viewportHelperMarkup({ channel: CH, touch: true, nonce: "n0nce" });
  expect(phone).toStartWith('<style nonce="n0nce">*{scrollbar-width:none}');
  expect(phone).toContain(`<script nonce="n0nce">(function(){"use strict";`);
  expect(phone).toContain(JSON.stringify(CH));
  const desktop = viewportHelperMarkup({ channel: CH, touch: false, nonce: null });
  expect(desktop).toStartWith("<script>");
  expect(desktop).not.toContain("scrollbar-width");
  expect(() => viewportHelperMarkup({ channel: "nope", touch: false })).toThrow();
});

test("the helper's messages count only from the page's window, on this build's channel, in their exact shape", () => {
  const page = {};
  const ok = { source: page, data: { channel: CH, type: "content", width: 1080 } };
  expect(viewportMessage(ok, page, CH)).toEqual({ type: "content", width: 1080 });
  expect(viewportMessage({ ...ok, data: { ...ok.data, width: 1e9 } }, page, CH)).toEqual({ type: "content", width: CONTENT_WIDTH_MAX });
  expect(viewportMessage(ok, {}, CH)).toBeNull();
  expect(viewportMessage(ok, page, "f".repeat(32))).toBeNull();
  expect(viewportMessage(ok, page, null)).toBeNull();
  expect(viewportMessage({ source: page, data: { ...ok.data, extra: 1 } }, page, CH)).toBeNull();
  for (const width of [0, -5, Number.NaN, "1080"]) {
    expect(viewportMessage({ source: page, data: { ...ok.data, width } }, page, CH)).toBeNull();
  }
  expect(viewportMessage({ source: page, data: { channel: CH, type: "escape" } }, page, CH)).toEqual({ type: "escape" });
  expect(viewportMessage({ source: page, data: { channel: CH, type: "escape", key: "x" } }, page, CH)).toBeNull();
  expect(viewportMessage({ source: {}, data: { channel: CH, type: "escape" } }, page, CH)).toBeNull();
});

test("the helper passes on an Escape the page left alone", () => {
  expect(viewportHelperMarkup({ channel: CH, touch: false })).toContain('"escape"');
});

test("in a pane a device is never drawn past its real size; filling the window it may be", () => {
  const room = { width: 3000, height: 3000 };
  expect(fitViewport("phone", room).scale).toBe(1);
  const big = fitViewport("phone", room, undefined, 4);
  expect(big.scale).toBeGreaterThan(1);
  expect(big.frame.height).toBeCloseTo(3000, 6);
  expect(fitViewport("phone", { width: 1e6, height: 1e6 }, undefined, 4).scale).toBe(4);
});
