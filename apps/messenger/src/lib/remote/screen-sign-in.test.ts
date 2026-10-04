import { afterEach, expect, test } from "bun:test";
import { rememberedSignIn, useSignInDriver, type SignInDriver } from "./screen-sign-in.ts";

function store(): SignInDriver & { row: unknown } {
  const s = {
    row: null as unknown,
    async get() { return s.row; },
    async set(row: unknown) { s.row = row; },
    async remove() { s.row = null; },
  };
  return s as SignInDriver & { row: unknown };
}
afterEach(() => useSignInDriver(null));

test("a sign-in is kept for the Mac and the pairing it was typed under, and nowhere else", async () => {
  const driver = store();
  useSignInDriver(driver);
  const mine = rememberedSignIn({ hostId: "H1", deviceId: "D1" });
  expect(await mine.load()).toBeNull();
  await mine.save({ username: "zhaodongsheng", password: "secret" });
  expect(await mine.load()).toEqual({ username: "zhaodongsheng", password: "secret" });
  // Paired again, or another Mac: not this sign-in.
  expect(await rememberedSignIn({ hostId: "H1", deviceId: "D2" }).load()).toBeNull();
  expect(await rememberedSignIn({ hostId: "H2", deviceId: "D1" }).load()).toBeNull();
  await mine.forget();
  expect(await mine.load()).toBeNull();
});

test("storage that fails is a sign-in asked for again, never an error", async () => {
  useSignInDriver({ get: async () => { throw new Error("no idb"); }, set: async () => { throw new Error("no idb"); }, remove: async () => { throw new Error("no idb"); } });
  const signIn = rememberedSignIn({ hostId: "H1", deviceId: "D1" });
  expect(await signIn.load()).toBeNull();
  await signIn.save({ password: "x" });
  await signIn.forget();
});
