import { expect, test } from "bun:test";
import { formatDeviceLastActive } from "./device-last-active.ts";

const now = Date.UTC(2026, 8, 21, 12, 0, 0);
const secondsAgo = (seconds: number) => (now - seconds * 1000) / 1000;

test("Chinese device activity uses relative time buckets", () => {
  expect(formatDeviceLastActive(secondsAgo(10), now, "zh")).toBe("现在");
  expect(formatDeviceLastActive(secondsAgo(5 * 60), now, "zh")).toBe("5分钟前");
  expect(formatDeviceLastActive(secondsAgo(3 * 3600), now, "zh")).toBe("3小时前");
  expect(formatDeviceLastActive(secondsAgo(24 * 3600), now, "zh")).toBe("昨天");
});

test("English device activity uses localized relative time", () => {
  expect(formatDeviceLastActive(secondsAgo(10), now, "en")).toBe("now");
  expect(formatDeviceLastActive(secondsAgo(5 * 60), now, "en")).toBe("5 minutes ago");
  expect(formatDeviceLastActive(secondsAgo(3 * 3600), now, "en")).toBe("3 hours ago");
  expect(formatDeviceLastActive(secondsAgo(24 * 3600), now, "en")).toBe("yesterday");
});

test("future clock skew never displays future activity", () => {
  expect(formatDeviceLastActive((now + 60_000) / 1000, now, "zh")).toBe("现在");
});
