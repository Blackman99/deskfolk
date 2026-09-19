import { expect, test } from "bun:test";
import {
  formatMcpArgs,
  mapMcpError,
  parseMcpArgs,
  planMcpDraft,
  requestMcpAdd,
  requestMcpSave,
} from "./mcp-form.ts";

const stdioDraft = {
  name: " probe ",
  transport: "stdio" as const,
  command: " bun ",
  args: "run src/mcp-fixture.ts --modern-only",
  url: "",
  headers: "",
  auth: "",
  enabled: true,
  usageNote: "",
};

test("empty name and command do not produce a body", () => {
  expect(
    planMcpDraft({ ...stdioDraft, name: "  ", command: "", args: "a" }),
  ).toEqual({
    ok: false,
    errors: { name: "empty", command: "empty" },
  });
});

test("add from the edit phase only advances to confirm, never a POST body", () => {
  expect(
    requestMcpAdd("edit", stdioDraft),
  ).toEqual({ ok: true, phase: "confirm" });
});

test("add confirm submits trimmed fields and split args", () => {
  expect(
    requestMcpAdd("confirm", {
      ...stdioDraft,
      args: "  run   src/mcp-fixture.ts  --modern-only ",
    }),
  ).toEqual({
    ok: true,
    phase: "submit",
    body: {
      name: "probe",
      transport: "stdio",
      command: "bun",
      args: ["run", "src/mcp-fixture.ts", "--modern-only"],
      enabled: true,
    },
  });
});

test("http add confirm submits url and strips Authorization from headers", () => {
  expect(
    requestMcpAdd("confirm", {
      name: "cpa",
      transport: "http",
      command: "",
      args: "",
      url: " https://cpa.westlakedata.xyz/mcp ",
      headers: "Authorization: Bearer secret\nX-Debug: 1",
      auth: "Bearer secret",
      enabled: true,
      usageNote: "",
    }),
  ).toEqual({
    ok: true,
    phase: "submit",
    body: {
      name: "cpa",
      transport: "http",
      url: "https://cpa.westlakedata.xyz/mcp",
      headers: [{ name: "X-Debug", value: "1" }],
      auth: "Bearer secret",
      enabled: true,
    },
  });
});

test("empty args serialize to an empty list", () => {
  expect(parseMcpArgs("   ")).toEqual([]);
  expect(formatMcpArgs([])).toBe("");
});

test("a usage note is trimmed into the create body and omitted when blank", () => {
  expect(
    requestMcpAdd("confirm", { ...stdioDraft, usageNote: "  Only for the real-bot repo.  " }),
  ).toEqual({
    ok: true,
    phase: "submit",
    body: {
      name: "probe",
      transport: "stdio",
      command: "bun",
      args: ["run", "src/mcp-fixture.ts", "--modern-only"],
      enabled: true,
      usage_note: "Only for the real-bot repo.",
    },
  });
  const blank = requestMcpAdd("confirm", { ...stdioDraft, usageNote: "   " });
  expect(blank.ok && blank.phase === "submit" && "usage_note" in blank.body).toBe(false);
});

test("changing only the usage note submits a PATCH without confirm", () => {
  const current = { name: "probe", transport: "stdio" as const, command: "bun", args: ["run", "fix.ts"], url: null, headers: [], usage_note: null };
  expect(
    requestMcpSave("edit", current, { ...stdioDraft, command: "bun", args: "run fix.ts", usageNote: "Read-only." }),
  ).toEqual({ ok: true, phase: "submit", patch: { usage_note: "Read-only." } });
  expect(
    requestMcpSave(
      "edit",
      { ...current, usage_note: "Read-only." },
      { ...stdioDraft, command: "bun", args: "run fix.ts", usageNote: "  " },
    ),
  ).toEqual({ ok: true, phase: "submit", patch: { usage_note: null } });
  expect(
    requestMcpSave(
      "edit",
      { ...current, usage_note: "Read-only." },
      { ...stdioDraft, command: "bun", args: "run fix.ts", usageNote: "Read-only." },
    ),
  ).toEqual({ ok: true, phase: "submit", patch: {} });
});

test("name-only save submits a PATCH without confirm", () => {
  expect(
    requestMcpSave(
      "edit",
      { name: "probe", transport: "stdio", command: "bun", args: ["run", "fix.ts"], url: null, headers: [] },
      { ...stdioDraft, name: "time", command: "bun", args: "run fix.ts" },
    ),
  ).toEqual({
    ok: true,
    phase: "submit",
    patch: { name: "time" },
  });
});

test("changing command from the edit phase only advances to confirm", () => {
  expect(
    requestMcpSave(
      "edit",
      { name: "probe", transport: "stdio", command: "bun", args: ["run", "fix.ts"], url: null, headers: [] },
      { ...stdioDraft, command: "npx", args: "run fix.ts" },
    ),
  ).toEqual({ ok: true, phase: "confirm" });
});

test("changing args from the edit phase only advances to confirm", () => {
  expect(
    requestMcpSave(
      "edit",
      { name: "probe", transport: "stdio", command: "bun", args: ["run", "fix.ts"], url: null, headers: [] },
      { ...stdioDraft, args: "run other.ts" },
    ),
  ).toEqual({ ok: true, phase: "confirm" });
});

test("confirm of a command change submits the PATCH", () => {
  expect(
    requestMcpSave(
      "confirm",
      { name: "probe", transport: "stdio", command: "bun", args: ["run", "fix.ts"], url: null, headers: [] },
      { ...stdioDraft, command: "npx", args: "run fix.ts --legacy-only", enabled: false },
    ),
  ).toEqual({
    ok: true,
    phase: "submit",
    patch: { command: "npx", args: ["run", "fix.ts", "--legacy-only"] },
  });
});

test("unchanged row submits an empty patch", () => {
  expect(
    requestMcpSave(
      "edit",
      { name: "probe", transport: "stdio", command: "bun", args: [], url: null, headers: [] },
      { ...stdioDraft, args: "" },
    ),
  ).toEqual({ ok: true, phase: "submit", patch: {} });
});

test("maps daemon required-field messages onto the locked kinds", () => {
  expect(mapMcpError("name is required")).toEqual({ name: "empty" });
  expect(mapMcpError("command is required")).toEqual({ command: "empty" });
  expect(mapMcpError("url is required")).toEqual({ url: "empty" });
  expect(mapMcpError("url must be an http or https URL")).toEqual({ url: "invalid" });
  expect(mapMcpError("mcp server not found")).toEqual({ top: true });
});
