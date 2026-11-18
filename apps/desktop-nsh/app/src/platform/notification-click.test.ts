import { expect, test } from "nsh/test";
import { openClickedBanner, type ClickDeps } from "./notification-click";

function fixture(intent: unknown, connected = true) {
  const opened: string[] = [];
  let taken = 0;
  const deps: ClickDeps = {
    connected: () => connected,
    take: async () => {
      taken++;
      return intent;
    },
    open: async (clickRef) => void opened.push(clickRef),
  };
  return { deps, opened, taken: () => taken };
}

test("the shell's word opens the clicked banner's conversation", async () => {
  const f = fixture({ clickRef: "ref-1" });
  await openClickedBanner(f.deps);
  expect(f.opened).toEqual(["ref-1"]);
});

test("nothing waiting, or the shell refusing, opens nothing", async () => {
  const none = fixture(null);
  await openClickedBanner(none.deps);
  expect(none.opened).toEqual([]);

  const failing = fixture(null);
  failing.deps.take = async () => {
    throw new Error("intent_buffer_poisoned");
  };
  await openClickedBanner(failing.deps);
  expect(failing.opened).toEqual([]);
});

test("a window still connecting leaves the reference for its first snapshot", async () => {
  const f = fixture({ clickRef: "ref-2" }, false);
  await openClickedBanner(f.deps);
  expect(f.taken()).toBe(0);
  expect(f.opened).toEqual([]);
});
