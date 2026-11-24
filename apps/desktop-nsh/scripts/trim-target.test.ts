import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseFingerprintDeps, sizeOf, trimNshCache, trimTarget } from "./trim-target";

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const dirs: string[] = [];

function target(): string {
  const dir = mkdtempSync(join(tmpdir(), "trim-target-"));
  dirs.push(dir);
  return join(dir, "target");
}

function file(path: string, bytes: number, ageDays = 0): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, Buffer.alloc(bytes));
  const at = new Date(Date.now() - ageDays * DAY);
  utimesSync(path, at, at);
}

function textFile(path: string, content: string, ageMs = 0): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, content);
  const at = new Date(Date.now() - ageMs);
  utimesSync(path, at, at);
}

/** Sets a directory's mtime, as rustc's last write into it would have. */
function age(path: string, days: number): void {
  const at = new Date(Date.now() - days * DAY);
  utimesSync(path, at, at);
}

function ageMs(path: string, ms: number): void {
  const at = new Date(Date.now() - ms);
  utimesSync(path, at, at);
}

/** Converts a 16-char lowercase hex little-endian fingerprint value into the u64 Cargo writes in json `deps`. */
function leHexToU64(hex: string): string {
  const buf = Buffer.from(hex, "hex");
  return new DataView(buf.buffer, buf.byteOffset, 8).getBigUint64(0, true).toString();
}

/** Writes one synthetic Cargo build unit (`.fingerprint/<crate>-<hash>` + optional artifact in `deps/`). */
function unit(
  profile: string,
  spec: {
    crate: string;
    hash: string;
    kind: string;
    fpVal: string;
    depFpVals?: string[];
    depArtifact?: { name: string; bytes: number };
    ageMs: number;
  },
): void {
  const fpDir = join(profile, ".fingerprint", `${spec.crate}-${spec.hash}`);
  const depsJson = (spec.depFpVals ?? []).map((hex, i) => `[${i + 1},"dep_${i}",false,${leHexToU64(hex)}]`).join(",");
  textFile(join(fpDir, spec.kind), spec.fpVal, spec.ageMs);
  textFile(join(fpDir, `${spec.kind}.json`), `{"rustc":1,"deps":[${depsJson}],"local":[]}`, spec.ageMs);
  ageMs(fpDir, spec.ageMs);
  if (spec.depArtifact) {
    const depPath = join(profile, "deps", spec.depArtifact.name);
    mkdirSync(join(depPath, ".."), { recursive: true });
    writeFileSync(depPath, Buffer.alloc(spec.depArtifact.bytes));
    ageMs(depPath, spec.ageMs);
  }
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("parseFingerprintDeps", () => {
  test("preserves 64-bit u64 hashes beyond Number.MAX_SAFE_INTEGER as little-endian hex", () => {
    const raw =
      '{"rustc":13976775244188850736,"deps":[[6345685359513376590,"nsh_base",false,15558422854184396766],[1,"other",true,18446744073709551615]],"local":[[9,"ignored",false,42]]}';
    expect(parseFingerprintDeps(raw)).toEqual(["dee7fa60279fead7", "ffffffffffffffff"]);
  });
});

describe("trimTarget", () => {
  test("removes incremental caches older than the age, keeps fresh ones and the artifacts", () => {
    const t = target();
    file(join(t, "debug", "incremental", "old-abc", "s", "a.bin"), 100, 5);
    file(join(t, "debug", "incremental", "fresh-def", "s", "a.bin"), 100, 0);
    file(join(t, "debug", "deps", "libx-0123456789abcdef.rlib"), 100, 30);
    age(join(t, "debug", "incremental", "old-abc"), 5);
    const size = trimTarget(t, { capBytes: 0, incrementalAgeMs: 2 * DAY, log: () => {} });
    expect(existsSync(join(t, "debug", "incremental", "old-abc"))).toBe(false);
    expect(existsSync(join(t, "debug", "incremental", "fresh-def"))).toBe(true);
    expect(existsSync(join(t, "debug", "deps", "libx-0123456789abcdef.rlib"))).toBe(true);
    expect(size).toBe(200);
  });

  test("over the cap, incremental goes first", () => {
    const t = target();
    file(join(t, "debug", "incremental", "x", "a.bin"), 600);
    file(join(t, "debug", "deps", "a.rlib"), 300);
    expect(trimTarget(t, { capBytes: 500, incrementalAgeMs: 2 * DAY, log: () => {} })).toBe(300);
    expect(existsSync(join(t, "debug", "incremental"))).toBe(false);
    expect(existsSync(join(t, "debug", "deps", "a.rlib"))).toBe(true);
  });

  test("still over the cap, the whole directory goes", () => {
    const t = target();
    file(join(t, "debug", "incremental", "x", "a.bin"), 100);
    file(join(t, "debug", "deps", "a.rlib"), 900);
    expect(trimTarget(t, { capBytes: 500, incrementalAgeMs: 2 * DAY, log: () => {} })).toBe(0);
    expect(existsSync(t)).toBe(false);
  });

  test("a dry run removes nothing", () => {
    const t = target();
    file(join(t, "debug", "incremental", "old", "a.bin"), 100, 5);
    file(join(t, "debug", "deps", "a.rlib"), 900);
    age(join(t, "debug", "incremental", "old"), 5);
    trimTarget(t, { capBytes: 500, incrementalAgeMs: 2 * DAY, dryRun: true, log: () => {} });
    expect(sizeOf(t)).toBe(1000);
  });

  test("prunes superseded build units while keeping old deps reachable from the newest build", () => {
    const t = target();
    const debug = join(t, "debug");
    // Shared dep built 30 days ago, still needed by the newest build.
    unit(debug, {
      crate: "shared",
      hash: "1111111111111111",
      kind: "lib-shared",
      fpVal: "a1a1a1a1a1a1a1a1",
      depArtifact: { name: "libshared-1111111111111111.rlib", bytes: 400 },
      ageMs: 30 * DAY,
    });
    // Old NSH dep only used by the superseded binary.
    unit(debug, {
      crate: "nsh-base",
      hash: "2222222222222222",
      kind: "lib-nsh_base",
      fpVal: "b2b2b2b2b2b2b2b2",
      depArtifact: { name: "libnsh_base-2222222222222222.rlib", bytes: 700 },
      ageMs: 5 * DAY,
    });
    // Superseded binary (5 days old).
    unit(debug, {
      crate: "deskfolk-nsh",
      hash: "3333333333333333",
      kind: "bin-deskfolk-nsh",
      fpVal: "c3c3c3c3c3c3c3c3",
      depFpVals: ["a1a1a1a1a1a1a1a1", "b2b2b2b2b2b2b2b2"],
      depArtifact: { name: "deskfolk_nsh-3333333333333333", bytes: 300 },
      ageMs: 5 * DAY,
    });
    // Current NSH dep (1 day old).
    unit(debug, {
      crate: "nsh-base",
      hash: "4444444444444444",
      kind: "lib-nsh_base",
      fpVal: "d4d4d4d4d4d4d4d4",
      depArtifact: { name: "libnsh_base-4444444444444444.rlib", bytes: 700 },
      ageMs: 1 * DAY,
    });
    // Current binary (1 day old).
    unit(debug, {
      crate: "deskfolk-nsh",
      hash: "5555555555555555",
      kind: "bin-deskfolk-nsh",
      fpVal: "e5e5e5e5e5e5e5e5",
      depFpVals: ["a1a1a1a1a1a1a1a1", "d4d4d4d4d4d4d4d4"],
      depArtifact: { name: "deskfolk_nsh-5555555555555555", bytes: 300 },
      ageMs: 1 * DAY,
    });
    // A newer `cargo check` (no compiled binary in deps/) must NOT evict `cargo build`.
    unit(debug, {
      crate: "deskfolk-nsh",
      hash: "6666666666666666",
      kind: "bin-deskfolk-nsh",
      fpVal: "f6f6f6f6f6f6f6f6",
      depFpVals: ["a1a1a1a1a1a1a1a1", "d4d4d4d4d4d4d4d4"],
      ageMs: 3 * HOUR,
    });

    trimTarget(t, { capBytes: 0, incrementalAgeMs: 2 * DAY, deadAgeMs: 2 * HOUR, log: () => {} });

    // Superseded binary and its exclusive old dep are gone.
    expect(existsSync(join(debug, "deps", "deskfolk_nsh-3333333333333333"))).toBe(false);
    expect(existsSync(join(debug, "deps", "libnsh_base-2222222222222222.rlib"))).toBe(false);
    expect(existsSync(join(debug, ".fingerprint", "nsh-base-2222222222222222"))).toBe(false);
    // Live build, live check, current dep, and 30-day-old shared dep all stay.
    expect(existsSync(join(debug, "deps", "deskfolk_nsh-5555555555555555"))).toBe(true);
    expect(existsSync(join(debug, "deps", "libnsh_base-4444444444444444.rlib"))).toBe(true);
    expect(existsSync(join(debug, "deps", "libshared-1111111111111111.rlib"))).toBe(true);
    expect(existsSync(join(debug, ".fingerprint", "deskfolk-nsh-6666666666666666"))).toBe(true);
  });

  test("over the cap, removes recent unreachable units before wiping the whole target", () => {
    const t = target();
    const debug = join(t, "debug");
    // Recent superseded build (30 min ago, younger than 2h deadAgeMs) pushing size over cap.
    unit(debug, {
      crate: "app",
      hash: "1111111111111111",
      kind: "bin-app",
      fpVal: "1111111111111111",
      depArtifact: { name: "app-1111111111111111", bytes: 800 },
      ageMs: 30 * 60 * 1000,
    });
    // Current build (5 min ago), under cap on its own.
    unit(debug, {
      crate: "app",
      hash: "2222222222222222",
      kind: "bin-app",
      fpVal: "2222222222222222",
      depArtifact: { name: "app-2222222222222222", bytes: 400 },
      ageMs: 5 * 60 * 1000,
    });

    const after = trimTarget(t, { capBytes: 700, incrementalAgeMs: 2 * DAY, deadAgeMs: 2 * HOUR, log: () => {} });
    expect(after).toBeGreaterThan(0);
    expect(after).toBeLessThanOrEqual(700);
    expect(existsSync(join(debug, "deps", "app-1111111111111111"))).toBe(false);
    expect(existsSync(join(debug, "deps", "app-2222222222222222"))).toBe(true);
  });

  test("skips dead-unit pruning safely when fingerprint dependency hashes do not resolve", () => {
    const t = target();
    const debug = join(t, "debug");
    // 5 unmatched dep edges simulates an unrecognized future Cargo fingerprint format.
    unit(debug, {
      crate: "app",
      hash: "1111111111111111",
      kind: "bin-app",
      fpVal: "1111111111111111",
      depFpVals: ["0000000000000001", "0000000000000002", "0000000000000003", "0000000000000004", "0000000000000005"],
      depArtifact: { name: "app-1111111111111111", bytes: 300 },
      ageMs: 5 * DAY,
    });
    unit(debug, {
      crate: "app",
      hash: "2222222222222222",
      kind: "bin-app",
      fpVal: "2222222222222222",
      depArtifact: { name: "app-2222222222222222", bytes: 300 },
      ageMs: 1 * DAY,
    });

    trimTarget(t, { capBytes: 0, incrementalAgeMs: 2 * DAY, deadAgeMs: 2 * HOUR, log: () => {} });
    expect(existsSync(join(debug, "deps", "app-1111111111111111"))).toBe(true);
    expect(existsSync(join(debug, "deps", "app-2222222222222222"))).toBe(true);
  });
});

describe("trimNshCache", () => {
  const KEEP = "a".repeat(40);
  const OLD = "b".repeat(40);
  const RECENT = "c".repeat(40);

  /** A cache with this checkout's commit, one unused for 30 days, one used yesterday, Ghostty's. */
  function cache(): string {
    const root = join(target(), "..", "cache");
    for (const [rev, days] of [[KEEP, 30], [OLD, 30], [RECENT, 1]] as const) {
      file(join(root, rev, "source", "target", "release", "nsh"), 100);
      file(join(root, rev, "last-used"), 0, days);
    }
    file(join(root, "ghostty", "0123abc", "src.tar"), 100);
    age(join(root, "ghostty"), 30);
    return root;
  }

  test("removes the commits other than this checkout's that nothing used lately", () => {
    const root = cache();
    trimNshCache(root, { keep: KEEP, unusedMs: 7 * DAY, log: () => {} });
    expect(existsSync(join(root, KEEP))).toBe(true);
    expect(existsSync(join(root, OLD))).toBe(false);
    expect(existsSync(join(root, OLD + ".removing"))).toBe(false);
    expect(existsSync(join(root, RECENT))).toBe(true);
    expect(existsSync(join(root, "ghostty"))).toBe(true);
  });

  test("a commit without a stamp goes by its directory's age", () => {
    const root = cache();
    rmSync(join(root, OLD, "last-used"));
    age(join(root, OLD), 30);
    trimNshCache(root, { keep: KEEP, unusedMs: 7 * DAY, log: () => {} });
    expect(existsSync(join(root, OLD))).toBe(false);
  });

  test("finishes what an earlier removal left", () => {
    const root = cache();
    file(join(root, OLD + ".removing", "source", "half.rs"), 100);
    trimNshCache(root, { keep: KEEP, unusedMs: 365 * DAY, log: () => {} });
    expect(existsSync(join(root, OLD + ".removing"))).toBe(false);
    expect(existsSync(join(root, OLD))).toBe(true);
  });

  test("a dry run removes nothing", () => {
    const root = cache();
    const lines: string[] = [];
    trimNshCache(root, { keep: KEEP, unusedMs: 7 * DAY, dryRun: true, log: (line) => lines.push(line) });
    expect(existsSync(join(root, OLD))).toBe(true);
    expect(lines.join("\n")).toContain(OLD.slice(0, 12));
  });
});
