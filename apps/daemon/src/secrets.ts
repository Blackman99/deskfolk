import { KEYCHAIN_NAME, KEYCHAIN_SERVICE } from "@real-bot/protocol";
import type { EndpointKeyStore } from "./store";

function secretName(name?: string): string {
  return name && name.length > 0 ? name : KEYCHAIN_NAME;
}

export const bunKeyStore: EndpointKeyStore = {
  async get(name) {
    try {
      return await Bun.secrets.get({ service: KEYCHAIN_SERVICE, name: secretName(name) });
    } catch {
      return null;
    }
  },
  async set(value, name) {
    await Bun.secrets.set({
      service: KEYCHAIN_SERVICE,
      name: secretName(name),
      value,
      allowUnrestrictedAccess: false,
    });
  },
  async delete(name) {
    await Bun.secrets.delete({ service: KEYCHAIN_SERVICE, name: secretName(name) });
  },
};

export function memoryKeyStore(initial: string | null = null): EndpointKeyStore {
  const values = new Map<string, string>();
  if (initial !== null) values.set(KEYCHAIN_NAME, initial);
  return {
    async get(name) {
      return values.get(secretName(name)) ?? null;
    },
    async set(next, name) {
      values.set(secretName(name), next);
    },
    async delete(name) {
      values.delete(secretName(name));
    },
  };
}
