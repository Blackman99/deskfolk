import { afterEach, expect, test } from "bun:test";
import { base64url, generateIdentity, identityPublic } from "@real-bot/remote";
import {
  assertEnrollment,
  memoryEnrollment,
  saveEnrollment,
  useEnrollmentDriver,
  type StoredEnrollment,
} from "./idb.ts";

const keys = generateIdentity();
const pub = identityPublic(keys);
const enrollment: StoredEnrollment = {
  v: 1,
  deviceId: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
  hostId: "01ARZ3NDEKTSV4RRFFQ69G5FAW",
  relayOrigin: "https://relay.example.test",
  relayId: "fixture",
  trustEpoch: 1,
  hostDhPublic: base64url(pub.dh),
  hostSigningPublic: base64url(pub.signing),
  dh: base64url(keys.dh),
  signing: base64url(keys.signing),
  enrollment: base64url(keys.enrollment),
  name: "Fixture",
};

const IDENTITY_KEYS = [
  "v",
  "deviceId",
  "hostId",
  "relayOrigin",
  "relayId",
  "trustEpoch",
  "hostDhPublic",
  "hostSigningPublic",
  "dh",
  "signing",
  "enrollment",
  "name",
] as const;

afterEach(() => useEnrollmentDriver(null));

test("assertEnrollment returns only the 12 identity fields and rejects unknown keys", () => {
  expect(Object.keys(assertEnrollment(enrollment))).toEqual([...IDENTITY_KEYS]);
  expect(() => assertEnrollment({ ...enrollment, drafts: "queued" })).toThrow();
  expect(() => assertEnrollment({ ...enrollment, snapshotHtml: "<p>x</p>" })).toThrow();
  expect(() => assertEnrollment({ ...enrollment, transcript: "secret" })).toThrow();
});

test("enrollment put stores the allowlisted identity literal, not caller extras", async () => {
  const stored: unknown[] = [];
  useEnrollmentDriver({
    async get() {
      return stored.at(-1) ?? null;
    },
    async set(value) {
      stored.push(value);
    },
  });
  await expect(saveEnrollment({ ...enrollment, drafts: "queued" } as never)).rejects.toThrow();
  await expect(saveEnrollment({ ...enrollment, snapshotHtml: "<p>" } as never)).rejects.toThrow();
  expect(stored).toEqual([]);
  await saveEnrollment(enrollment);
  expect(stored).toEqual([enrollment]);
  expect(Object.keys(stored[0] as object)).toEqual([...IDENTITY_KEYS]);
  const memory = memoryEnrollment();
  await expect(memory.set({ ...enrollment, drafts: "queued" } as never)).rejects.toThrow();
});
