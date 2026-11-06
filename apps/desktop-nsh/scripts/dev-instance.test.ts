import { describe, expect, test } from "bun:test";
import { KEYCHAIN_SERVICE, LOCAL_API_PORT } from "../../../packages/protocol/src/index.ts";
import { assertApartFromStable, devInstance, stableDataDir } from "./dev-instance";

describe("the dev instance stays apart from the stable one", () => {
  const home = "/Users/someone";

  test("its own port, data directory and Keychain service", () => {
    const dev = devInstance(home);
    expect(dev.port).not.toBe(LOCAL_API_PORT);
    expect(dev.bind).not.toContain(String(LOCAL_API_PORT));
    expect(dev.dataDir).not.toBe(stableDataDir(home));
    expect(dev.keychainService).not.toBe(KEYCHAIN_SERVICE);
    expect(() => assertApartFromStable(dev, home)).not.toThrow();
  });

  test("refuses the stable port", () => {
    const dev = { ...devInstance(home), port: LOCAL_API_PORT, bind: `127.0.0.1:${LOCAL_API_PORT}` };
    expect(() => assertApartFromStable(dev, home)).toThrow(/stable port/);
  });

  test("refuses the stable data directory, however it is spelled", () => {
    const dev = { ...devInstance(home), dataDir: `${stableDataDir(home)}/../real-bot` };
    expect(() => assertApartFromStable(dev, home)).toThrow(/stable data directory/);
  });

  test("refuses the stable Keychain service", () => {
    const dev = { ...devInstance(home), keychainService: KEYCHAIN_SERVICE };
    expect(() => assertApartFromStable(dev, home)).toThrow(/stable Keychain service/);
  });
});
