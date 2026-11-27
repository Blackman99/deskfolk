import "../../platform/install";
import { afterEach, expect, test } from "nsh/test";
import {
  forgetExternalLinkOpen,
  loadExternalLinkOpen,
} from "./external-link-open.ts";
import { externalLinkOpen } from "./external-link-open-store.svelte.ts";

afterEach(() => {
  forgetExternalLinkOpen();
  externalLinkOpen.reload();
});

test("store defaults to webview, persists locally and syncs with adopted profile writer", () => {
  const written: Array<string | null> = [];
  externalLinkOpen.adopt(undefined, (mode) => written.push(mode));
  expect(externalLinkOpen.mode).toBe("webview");
  expect(externalLinkOpen.isDefault).toBe(true);
  expect(externalLinkOpen.localChoice).toBeUndefined();

  externalLinkOpen.set("browser");
  expect(externalLinkOpen.mode).toBe("browser");
  expect(externalLinkOpen.isDefault).toBe(false);
  expect(externalLinkOpen.localChoice).toBe("browser");
  expect(loadExternalLinkOpen()).toBe("browser");
  expect(written).toEqual(["browser"]);

  externalLinkOpen.reset();
  expect(externalLinkOpen.mode).toBe("webview");
  expect(externalLinkOpen.isDefault).toBe(true);
  expect(externalLinkOpen.localChoice).toBeUndefined();
  expect(written).toEqual(["browser", null]);
});
