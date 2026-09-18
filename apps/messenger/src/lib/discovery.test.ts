import { expect, test } from "bun:test";
import { loopbackOrigin, parseDiscovery, parseTauriEndpoint } from "./discovery.ts";

test("dev discovery is port plus token, origin is loopback", () => {
  expect(parseDiscovery({ port: 17890, token: "abc" })).toEqual({
    origin: "http://127.0.0.1:17890",
    token: "abc",
  });
  expect(parseDiscovery({ name: "real-bot", port: 17890, token: "abc" })).toEqual({
    origin: "http://127.0.0.1:17890",
    token: "abc",
  });
});

test("IPv6 messenger page discovers the IPv6 loopback origin", () => {
  expect(loopbackOrigin(17890, "http://[::1]:5173")).toBe("http://[::1]:17890");
  expect(loopbackOrigin(17890, "http://localhost:5173")).toBe("http://127.0.0.1:17890");
  expect(parseDiscovery({ port: 17890, token: "abc" }, "http://[::1]:5173")).toEqual({
    origin: "http://[::1]:17890",
    token: "abc",
  });
});

test("missing or empty token is not a discovery", () => {
  expect(parseDiscovery({ port: 17890 })).toBeNull();
  expect(parseDiscovery({ port: 17890, token: "" })).toBeNull();
  expect(parseDiscovery(null)).toBeNull();
});

test("Tauri command returns origin plus token", () => {
  expect(parseTauriEndpoint({ origin: "http://127.0.0.1:17890", token: "t" })).toEqual({
    origin: "http://127.0.0.1:17890",
    token: "t",
  });
  expect(parseTauriEndpoint(null)).toBeNull();
});

test("browser discovery uses the Vite path, not Application Support", async () => {
  const { discoverEndpoint } = await import("./discovery.ts");
  const fetchFn = (async (input: RequestInfo | URL) => {
    expect(String(input)).toBe("/__local-api");
    return new Response(JSON.stringify({ port: 17890, token: "from-vite" }), {
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;
  await expect(discoverEndpoint(fetchFn, undefined, "http://localhost:5173")).resolves.toEqual({
    origin: "http://127.0.0.1:17890",
    token: "from-vite",
  });
  await expect(discoverEndpoint(fetchFn, undefined, "http://[::1]:5173")).resolves.toEqual({
    origin: "http://[::1]:17890",
    token: "from-vite",
  });
});

test("Tauri discovery does not fall through to Vite", async () => {
  const { discoverEndpoint } = await import("./discovery.ts");
  const fetchFn = (async () => {
    throw new Error("browser discovery must not run in Tauri");
  }) as typeof fetch;
  await expect(
    discoverEndpoint(fetchFn, {
      invoke: async () => ({ origin: "http://127.0.0.1:17890", token: "from-tauri" }),
    }),
  ).resolves.toEqual({
    origin: "http://127.0.0.1:17890",
    token: "from-tauri",
  });
});
