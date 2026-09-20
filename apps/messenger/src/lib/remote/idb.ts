import { fromBase64url } from "@real-bot/remote";
import { isUlid } from "./ids.ts";
import { httpsOrigin } from "./origin.ts";

export const REMOTE_DB = "real-bot-remote";
export const REMOTE_STORE = "enrollment";
export const ENROLLMENT_KEY = "current";

export type StoredEnrollment = {
  v: 1;
  deviceId: string;
  hostId: string;
  relayOrigin: string;
  relayId: string;
  trustEpoch: number;
  hostDhPublic: string;
  hostSigningPublic: string;
  dh: string;
  signing: string;
  enrollment: string;
  name: string;
};

export type EnrollmentDriver = {
  get(): Promise<unknown>;
  set(value: StoredEnrollment): Promise<void>;
  clear(): Promise<void>;
};

const ENROLLMENT_KEYS = [
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

export function assertEnrollment(value: unknown): StoredEnrollment {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid enrollment");
  const row = value as Record<string, unknown>;
  const keys = Object.keys(row);
  if (keys.length !== ENROLLMENT_KEYS.length || keys.some((key) => !ENROLLMENT_KEYS.includes(key as (typeof ENROLLMENT_KEYS)[number]))) {
    throw new Error("enrollment must not store application data");
  }
  if (row.v !== 1) throw new Error("invalid enrollment");
  const enrollment: StoredEnrollment = {
    v: 1,
    deviceId: String(row.deviceId ?? ""),
    hostId: String(row.hostId ?? ""),
    relayOrigin: String(row.relayOrigin ?? ""),
    relayId: String(row.relayId ?? ""),
    trustEpoch: Number(row.trustEpoch),
    hostDhPublic: String(row.hostDhPublic ?? ""),
    hostSigningPublic: String(row.hostSigningPublic ?? ""),
    dh: String(row.dh ?? ""),
    signing: String(row.signing ?? ""),
    enrollment: String(row.enrollment ?? ""),
    name: String(row.name ?? ""),
  };
  if (!isUlid(enrollment.deviceId) || !isUlid(enrollment.hostId)) throw new Error("invalid enrollment");
  httpsOrigin(enrollment.relayOrigin);
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(enrollment.relayId)) throw new Error("invalid enrollment");
  if (!Number.isInteger(enrollment.trustEpoch) || enrollment.trustEpoch < 0) throw new Error("invalid enrollment");
  fromBase64url(enrollment.hostDhPublic, 32);
  fromBase64url(enrollment.hostSigningPublic, 32);
  fromBase64url(enrollment.dh, 32);
  fromBase64url(enrollment.signing, 32);
  fromBase64url(enrollment.enrollment, 32);
  if (enrollment.name.length === 0 || enrollment.name.length > 256) throw new Error("invalid enrollment");
  return enrollment;
}

export function memoryEnrollment(): EnrollmentDriver {
  let current: StoredEnrollment | null = null;
  return {
    async get() {
      return current;
    },
    async set(value) {
      current = assertEnrollment(value);
    },
    async clear() {
      current = null;
    },
  };
}

function idbDriver(): EnrollmentDriver {
  const open = () =>
    new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open(REMOTE_DB, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(REMOTE_STORE);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  return {
    async get() {
      const db = await open();
      try {
        return await new Promise((resolve, reject) => {
          const req = db.transaction(REMOTE_STORE, "readonly").objectStore(REMOTE_STORE).get(ENROLLMENT_KEY);
          req.onsuccess = () => resolve(req.result ?? null);
          req.onerror = () => reject(req.error);
        });
      } finally {
        db.close();
      }
    },
    async set(value) {
      const enrollment = assertEnrollment(value);
      const db = await open();
      try {
        await new Promise<void>((resolve, reject) => {
          const req = db.transaction(REMOTE_STORE, "readwrite").objectStore(REMOTE_STORE).put(enrollment, ENROLLMENT_KEY);
          req.onsuccess = () => resolve();
          req.onerror = () => reject(req.error);
        });
      } finally {
        db.close();
      }
    },
    async clear() {
      const db = await open();
      try {
        await new Promise<void>((resolve, reject) => {
          const req = db.transaction(REMOTE_STORE, "readwrite").objectStore(REMOTE_STORE).delete(ENROLLMENT_KEY);
          req.onsuccess = () => resolve();
          req.onerror = () => reject(req.error);
        });
      } finally {
        db.close();
      }
    },
  };
}

let driver: EnrollmentDriver | null = null;

export function useEnrollmentDriver(next: EnrollmentDriver | null): void {
  driver = next;
}

function activeDriver(): EnrollmentDriver {
  if (driver) return driver;
  if (typeof indexedDB === "undefined") return memoryEnrollment();
  return idbDriver();
}

export async function loadEnrollment(): Promise<StoredEnrollment | null> {
  const raw = await activeDriver().get();
  if (raw == null) return null;
  return assertEnrollment(raw);
}

export async function saveEnrollment(value: StoredEnrollment): Promise<void> {
  await activeDriver().set(assertEnrollment(value));
}
