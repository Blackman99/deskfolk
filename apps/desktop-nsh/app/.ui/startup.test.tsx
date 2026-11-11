/**
 * A window's start (`Main.tsx`): until the first snapshot is in, the connecting screen, never the
 * first-run onboarding the empty snapshot before it would ask for. Each test watches every render
 * (`waitUntil` looks after each change of the app), so a single frame of the onboarding fails it.
 * The fixture's runtime answers before the first frame here, so the moment before the snapshot is
 * held open by a runtime that never answers; without the gate that window sat on the onboarding.
 */
import { expect, open, test } from "nsh/test";
import { openApp, seeded } from "./fixture";

type App = Awaited<ReturnType<typeof openApp>>;

/** Waits for `done`, looking at every render; true when the onboarding was on any of them. */
async function onboardingSeenUntil(app: App, done: () => boolean, timeout: number): Promise<boolean> {
  let seen = app.shows("id:onboarding-screen");
  await app.waitUntil(
    () => {
      if (app.shows("id:onboarding-screen")) seen = true;
      return done();
    },
    { timeout },
  );
  return seen;
}

test("once the runtime answers, the connecting screen gives way to the shell", async () => {
  const app = await openApp();
  const seen = await onboardingSeenUntil(app, () => app.shows(`id:session-${seeded.writerDirect}`), 15_000);
  expect(seen).toBe(false);
  expect(app.shows("id:connecting")).toBe(false);
});

test("a runtime that cannot be reached is said so, with a Retry, and the onboarding never shows", async () => {
  // Nothing listens on the discard port: every attempt is refused at once.
  const dead = { origin: "http://127.0.0.1:9", token: "unused" };
  const app = await open("../App.tsx", {
    platform: "macos",
    width: 1100,
    height: 760,
    locale: "zh-CN",
    network: "live",
    host: {
      params: { ...dead, windowId: 1, material: "none" },
      handlers: { "tauri.local_api_endpoint": dead, "tauri.app_version": "0.0.0", "tauri.window_material": "none" },
    },
  });
  const seen = await onboardingSeenUntil(app, () => app.shows("id:unreachable"), 15_000);
  expect(seen).toBe(false);
  await app.waitFor("text:连不上运行时");
  expect(app.shows("id:retry-connection")).toBe(true);
  expect(app.shows(`id:session-${seeded.writerDirect}`)).toBe(false);
});
