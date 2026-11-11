/**
 * The NSH terminal (`--terminal nsh`) draws in the app's palette (`palette.rs`), as the canvas
 * terminal does, and recolours when the appearance changes.
 */
import { expect, test } from "nsh/test";
import { openStory } from "./fixture";

test("the NSH terminal draws in the app's palette and follows the appearance", async () => {
  const app = await openStory("terminal-palette", { colorScheme: "light" });
  await app.waitFor("text:red");
  expect(app.spanStyle("text:red").color).toBe("#c62828ff");
  expect(app.spanStyle("text:plain").color).toBe("#121c20ff");
  // Inverse with no colours: the palette's ground as its text.
  expect(app.spanStyle("text:inverse").color).toBe("#ffffffff");
  await app.setColorScheme("dark");
  await app.waitUntil(() => app.spanStyle("text:red").color === "#ef6b6bff");
  expect(app.spanStyle("text:plain").color).toBe("#eef2f3ff");
  expect(app.spanStyle("text:inverse").color).toBe("#192125ff");
});
