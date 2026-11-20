/**
 * A line you send flies from the box into the transcript (`send-flight`). A headless test sees only
 * where things end (an animation reads as its end value), so this checks the end: the line stands
 * in the transcript, fully shown, and no stand-in is left over it. The flight itself was checked in
 * a real window, slowed down, frame by frame.
 */
import { expect, test } from "nsh/test";
import { openStory } from "./fixture";

test("a line you send ends in the transcript fully shown, with no stand-in left", async () => {
  const app = await openStory("chat-stage");
  await app.waitFor("id:chat-stage", { timeout: 15_000 });
  await app.press("id:show-empty");
  await app.waitUntil(() => app.texts().includes("session:empty"), { timeout: 20_000 });
  await app.waitFor("id:chat-welcome", { timeout: 15_000 });
  try {
    const line = `flight ${Date.now()}`;
    await app.type("id:composer-input", line);
    await app.keyboard.press("enter");
    await app.waitUntil(() => app.shows("id:transcript") && app.texts().includes(line), { timeout: 15_000 });
    await app.waitUntil(() => !app.shows("id:send-flight") && app.viewStyle(`text:${line}`)?.effectiveOpacity === 1, { timeout: 5_000 });
    expect(app.count(`text:${line}`)).toBe(1);
    expect(app.value("id:composer-input") ?? "").toBe("");
  } finally {
    await app.press("id:story-cleanup");
    await app.waitUntil(() => app.texts().includes("cleaned"), { timeout: 15_000 });
  }
});
