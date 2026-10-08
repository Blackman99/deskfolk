import { describe, expect, test } from "bun:test";
import { isLocalEndpoint } from "./local-endpoint.ts";

describe("isLocalEndpoint", () => {
  test("loopback, localhost and mDNS names", () => {
    for (const url of [
      "http://localhost:11434/v1",
      "http://LOCALHOST:1234/v1",
      "http://ollama.localhost/v1",
      "http://127.0.0.1:8080/v1",
      "http://127.8.0.3/v1",
      "http://[::1]:11434/v1",
      "http://[::ffff:127.0.0.1]:8080/v1",
      "http://[::ffff:7f00:1]:8080/v1",
      "http://user:pw@localhost:11434/v1",
      "HTTP://LocalHost.:11434",
      "http://0.0.0.0:11434/v1",
      "http://mac-studio.local:11434/v1",
    ]) {
      expect(isLocalEndpoint(url)).toBe(true);
    }
  });

  test("private and link-local networks", () => {
    for (const url of [
      "http://10.0.0.5:11434/v1",
      "http://172.16.0.1/v1",
      "http://172.31.255.255/v1",
      "http://192.168.1.20:1234/v1",
      "http://169.254.10.10/v1",
      "http://[fd12:3456::1]:8000/v1",
      "http://[fe80::1]/v1",
    ]) {
      expect(isLocalEndpoint(url)).toBe(true);
    }
  });

  test("public hosts and addresses are not local", () => {
    for (const url of [
      "https://api.openai.com/v1",
      "https://api.anthropic.com",
      "http://172.32.0.1/v1",
      "http://192.169.1.1/v1",
      "http://8.8.8.8/v1",
      "http://[2001:db8::1]/v1",
      "https://localhost.example.com/v1",
      "http://[::ffff:8.8.8.8]/v1",
    ]) {
      expect(isLocalEndpoint(url)).toBe(false);
    }
  });

  test("empty or unparseable input is not local", () => {
    expect(isLocalEndpoint("")).toBe(false);
    expect(isLocalEndpoint(null)).toBe(false);
    expect(isLocalEndpoint(undefined)).toBe(false);
    expect(isLocalEndpoint("localhost:11434")).toBe(false);
    expect(isLocalEndpoint("not a url")).toBe(false);
  });
});
