import { afterEach, expect, test } from "bun:test";
import {
  EXTERNAL_LINK_OPEN_DEFAULT,
  forgetExternalLinkOpen,
  isExternalLinkOpen,
  loadExternalLinkOpen,
  normalizeWebUrl,
  resolveWebAddressInput,
  saveExternalLinkOpen,
  webUrlLabel,
} from "./external-link-open.ts";

afterEach(() => {
  forgetExternalLinkOpen();
});

test("defaults to webview on desktop and persists only non-default choice", () => {
  expect(EXTERNAL_LINK_OPEN_DEFAULT).toBe("webview");
  expect(loadExternalLinkOpen()).toBe("webview");
  saveExternalLinkOpen("browser");
  expect(localStorage.getItem("real-bot-external-link-open")).toBe("browser");
  expect(loadExternalLinkOpen()).toBe("browser");
  saveExternalLinkOpen("webview");
  expect(localStorage.getItem("real-bot-external-link-open")).toBeNull();
  expect(loadExternalLinkOpen()).toBe("webview");
});

test("invalid stored values fall back to default webview", () => {
  localStorage.setItem("real-bot-external-link-open", "safari");
  expect(loadExternalLinkOpen()).toBe("webview");
  expect(isExternalLinkOpen("webview")).toBe(true);
  expect(isExternalLinkOpen("browser")).toBe(true);
  expect(isExternalLinkOpen("other")).toBe(false);
});

test("normalizeWebUrl and resolveWebAddressInput accept http(s) and refuse unsafe schemes", () => {
  expect(normalizeWebUrl("https://example.com/a")).toBe("https://example.com/a");
  expect(normalizeWebUrl("http://localhost:3000/test")).toBe("http://localhost:3000/test");
  expect(normalizeWebUrl("javascript:alert(1)")).toBeNull();
  expect(normalizeWebUrl("file:///etc/passwd")).toBeNull();
  expect(normalizeWebUrl("mailto:a@b.com")).toBeNull();
  expect(normalizeWebUrl("https://example.com/has space")).toBeNull();

  expect(resolveWebAddressInput("example.com/docs")).toBe("https://example.com/docs");
  expect(resolveWebAddressInput("localhost:8080/health")).toBe("https://localhost:8080/health");
  expect(resolveWebAddressInput("http://127.0.0.1:8080")).toBe("http://127.0.0.1:8080/");
  expect(resolveWebAddressInput("javascript:alert(1)")).toBeNull();
  expect(resolveWebAddressInput("not a url")).toBeNull();
});

test("webUrlLabel returns a clean host without www", () => {
  expect(webUrlLabel("https://www.github.com/org/repo")).toBe("github.com");
  expect(webUrlLabel("https://docs.example.com:8443/guide")).toBe("docs.example.com:8443");
});
