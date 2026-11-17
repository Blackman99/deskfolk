import { expect, test } from "nsh/test";
import { asksToQuit, closeAction, launchedToQuit } from "./window-life";

test("the close button puts the window away on Windows and Linux, as 0.4.0 did", () => {
  expect(closeAction("windows", true, "closeButton")).toBe("hide");
  expect(closeAction("linux", true, "shortcut")).toBe("hide");
  // Logging out or shutting down closes, or the system would wait on the app.
  expect(closeAction("windows", true, "system")).toBe("quit");
  // No tray to bring it back from: minimized, never out of reach.
  expect(closeAction("linux", false, "closeButton")).toBe("minimize");
  // The Mac keeps its own close (the app stays in the menu bar).
  expect(closeAction("macos", true, "closeButton")).toBe("close");
});

test("a later launch with --quit ends the running copy", () => {
  expect(asksToQuit(["--quit"])).toBe(true);
  expect(asksToQuit(["--hidden"])).toBe(false);
  expect(asksToQuit([])).toBe(false);
});

test("a --quit that found no copy running ends at once", () => {
  expect(launchedToQuit({ quit: true })).toBe(true);
  expect(launchedToQuit({})).toBe(false);
  expect(launchedToQuit({ quit: "true" })).toBe(false);
});
