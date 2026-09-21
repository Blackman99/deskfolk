import { describe, expect, test } from "bun:test";
import {
  AVATAR_MAX_SOURCE_BYTES,
  avatarEditorMode,
  avatarEditorPrimaryActions,
  avatarSrc,
  boringAvatarName,
  botAvatarColor,
  classifyAvatarFile,
  compositeAvatarLayout,
  coverDrawParams,
  fileToAvatarDataUri,
  followGeneratedAvatar,
  isCustomAvatar,
  mimeFromAvatarFile,
  sessionAvatars,
} from "./avatar.ts";
import { generateBoringAvatar, type Bot, type SessionSummary } from "@real-bot/protocol";

describe("botAvatarColor", () => {
  test("is deterministic for the same seed", () => {
    const color1 = botAvatarColor("bot-123");
    const color2 = botAvatarColor("bot-123");
    expect(color1).toEqual(color2);
    expect(color1.bg).toBeTruthy();
    expect(color1.text).toBeTruthy();
    expect(botAvatarColor("").bg).toBeTruthy();
  });
});

describe("avatarSrc", () => {
  test("returns null for null, undefined, or empty strings", () => {
    expect(avatarSrc(null)).toBeNull();
    expect(avatarSrc(undefined)).toBeNull();
    expect(avatarSrc("")).toBeNull();
    expect(avatarSrc("   ")).toBeNull();
  });

  test("returns http / https / data urls as-is", () => {
    expect(avatarSrc("https://example.com/bot.png")).toBe("https://example.com/bot.png");
    expect(avatarSrc("http://localhost:8080/bot.png")).toBe("http://localhost:8080/bot.png");
    expect(avatarSrc("data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==")).toBe(
      "data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==",
    );
  });

  test("encodes raw svg strings into data:image/svg+xml data URIs", () => {
    const svg = generateBoringAvatar({ name: "Researcher" });
    const src = avatarSrc(svg);
    expect(src).not.toBeNull();
    expect(src?.startsWith("data:image/svg+xml;utf8,")).toBe(true);
    expect(src).toContain(encodeURIComponent("<svg"));
  });

  test("returns null for non-svg non-url junk strings", () => {
    expect(avatarSrc("just-some-random-text")).toBeNull();
  });
});

describe("isCustomAvatar", () => {
  test("treats raster data URIs and http(s) URLs as custom uploads", () => {
    expect(isCustomAvatar("data:image/jpeg;base64,abc")).toBe(true);
    expect(isCustomAvatar("data:image/png;base64,abc")).toBe(true);
    expect(isCustomAvatar("https://example.com/bot.png")).toBe(true);
    expect(isCustomAvatar("http://localhost/bot.png")).toBe(true);
  });

  test("does not treat generated SVG as a custom upload", () => {
    expect(isCustomAvatar(generateBoringAvatar({ name: "Writer" }))).toBe(false);
    expect(isCustomAvatar("data:image/svg+xml;utf8,%3Csvg")).toBe(false);
    expect(isCustomAvatar("")).toBe(false);
    expect(isCustomAvatar(null)).toBe(false);
  });
});

describe("generated avatar from the Bot name", () => {
  test("uses the trimmed name, and a salt only after Randomize", () => {
    expect(boringAvatarName("")).toBe("bot");
    expect(boringAvatarName("  Writer  ")).toBe("Writer");
    expect(boringAvatarName("Writer", 0)).toBe("Writer");
    expect(boringAvatarName("Writer", 3)).toBe("Writer_3");
  });

  test("an empty create draft follows the name as it is typed", () => {
    const empty = generateBoringAvatar({ name: "bot" });
    const writer = generateBoringAvatar({ name: "Writer" });
    const first = followGeneratedAvatar({
      name: "",
      current: "",
      lastGenerated: "",
    });
    expect(first.avatar).toBe(empty);
    expect(first.changed).toBe(true);
    const renamed = followGeneratedAvatar({
      name: "Writer",
      current: first.avatar,
      lastGenerated: first.lastGenerated,
    });
    expect(renamed.avatar).toBe(writer);
    expect(renamed.changed).toBe(true);
  });

  test("an uploaded image stays put when the name changes", () => {
    const upload = "data:image/jpeg;base64,abc";
    const held = followGeneratedAvatar({
      name: "Writer",
      current: upload,
      lastGenerated: generateBoringAvatar({ name: "bot" }),
    });
    expect(held.avatar).toBe(upload);
    expect(held.changed).toBe(false);
  });

  test("a stored generated drawing is left alone until Randomize or Style", () => {
    const stored = generateBoringAvatar({ name: "Writer", variant: "pixel" });
    const held = followGeneratedAvatar({
      name: "Scribe",
      current: stored,
      lastGenerated: "",
    });
    expect(held.avatar).toBe(stored);
    expect(held.changed).toBe(false);
  });

  test("Randomize keeps following the name with the same salt", () => {
    const fromEmpty = generateBoringAvatar({ name: "bot_2" });
    const next = followGeneratedAvatar({
      name: "Writer",
      salt: 2,
      current: fromEmpty,
      lastGenerated: fromEmpty,
    });
    expect(next.avatar).toBe(generateBoringAvatar({ name: "Writer_2" }));
    expect(next.changed).toBe(true);
  });
});

describe("avatar editor chrome", () => {
  test("generated avatars randomize in place; uploads switch back via Style", () => {
    expect(avatarEditorMode(generateBoringAvatar({ name: "Writer" }))).toBe("generated");
    expect(avatarEditorMode("data:image/jpeg;base64,abc")).toBe("custom");
    expect(avatarEditorPrimaryActions("generated")).toEqual(["randomize", "upload"]);
    expect(avatarEditorPrimaryActions("custom")).toEqual(["style", "upload"]);
  });

  test("Randomize and Style never share a row", () => {
    for (const mode of ["generated", "custom"] as const) {
      const actions = avatarEditorPrimaryActions(mode);
      expect(actions.includes("randomize") && actions.includes("style")).toBe(false);
    }
  });
});

describe("classifyAvatarFile", () => {
  test("accepts png, jpeg, and webp; infers jpeg from .jpg names", () => {
    expect(classifyAvatarFile({ type: "image/png", name: "a.png", size: 12 })).toBeNull();
    expect(classifyAvatarFile({ type: "image/jpeg", name: "a.jpg", size: 12 })).toBeNull();
    expect(classifyAvatarFile({ type: "image/webp", name: "a.webp", size: 12 })).toBeNull();
    expect(mimeFromAvatarFile({ type: "", name: "face.jpg" })).toBe("image/jpeg");
    expect(classifyAvatarFile({ type: "", name: "face.jpg", size: 12 })).toBeNull();
  });

  test("rejects svg, gif, and oversized files", () => {
    expect(classifyAvatarFile({ type: "image/svg+xml", name: "a.svg", size: 12 })).toBe("type");
    expect(classifyAvatarFile({ type: "image/gif", name: "a.gif", size: 12 })).toBe("type");
    expect(classifyAvatarFile({ type: "text/plain", name: "a.txt", size: 12 })).toBe("type");
    expect(
      classifyAvatarFile({ type: "image/png", name: "a.png", size: AVATAR_MAX_SOURCE_BYTES + 1 }),
    ).toBe("size");
  });

  test("fileToAvatarDataUri rejects disallowed types before decode", async () => {
    const file = new File(["not-an-image"], "notes.txt", { type: "text/plain" });
    expect(await fileToAvatarDataUri(file)).toEqual({ ok: false, error: "type" });
  });
});

describe("coverDrawParams", () => {
  test("center-crops a landscape source onto a square", () => {
    expect(coverDrawParams(200, 100, 256)).toEqual({
      dx: -128,
      dy: 0,
      dw: 512,
      dh: 256,
      edge: 256,
    });
  });

  test("center-crops a portrait source onto a square", () => {
    expect(coverDrawParams(100, 200, 256)).toEqual({
      dx: 0,
      dy: -128,
      dw: 256,
      dh: 512,
      edge: 256,
    });
  });
});

describe("sessionAvatars", () => {
  const writer: Bot = {
    id: "writer",
    name: "Writer",
    duties: "",
    boundaries: "",
    avatar: generateBoringAvatar({ name: "Writer" }),
    model: null,
    archived_at: null,
    created_at: "t",
    updated_at: "t",
  };
  const reviewer: Bot = {
    ...writer,
    id: "reviewer",
    name: "审查员",
    avatar: "https://example.com/reviewer.png",
  };
  const bots = new Map([[writer.id, writer], [reviewer.id, reviewer]]);

  function direct(members: string[]): SessionSummary {
    return {
      id: "session",
      kind: "direct",
      name: null,
      created_at: "t",
      updated_at: "t",
      participants: members.map((member) => ({ member, joined_at: "t", left_at: null })),
    };
  }

  test("you↔Bot shows only the Bot's saved avatar", () => {
    expect(sessionAvatars(direct(["user", "writer"]), bots)).toEqual([
      { id: "writer", name: "Writer", src: avatarSrc(writer.avatar) },
    ]);
  });

  test("Bot↔Bot shows both avatars in participant order", () => {
    expect(sessionAvatars(direct(["reviewer", "writer"]), bots)).toEqual([
      { id: "reviewer", name: "审查员", src: reviewer.avatar },
      { id: "writer", name: "Writer", src: avatarSrc(writer.avatar) },
    ]);
  });

  test("groups show member bot avatars in participant order", () => {
    const group = { ...direct(["user", "writer", "reviewer"]), kind: "group" as const, name: "Brief" };
    expect(sessionAvatars(group, bots)).toEqual([
      { id: "writer", name: "Writer", src: avatarSrc(writer.avatar) },
      { id: "reviewer", name: "审查员", src: reviewer.avatar },
    ]);
  });

  test("participants who left are excluded", () => {
    const session = direct(["user", "reviewer", "writer"]);
    session.participants[1]!.left_at = "later";
    expect(sessionAvatars(session, bots).map((avatar) => avatar.id)).toEqual(["writer"]);
  });

  test("archived Bots keep their avatar", () => {
    const archived = new Map(bots);
    archived.set("writer", { ...writer, archived_at: "later" });
    expect(sessionAvatars(direct(["user", "writer"]), archived)[0]?.src).toBe(avatarSrc(writer.avatar));
  });

  test("deleted Bots retain a placeholder without exposing their id as a name", () => {
    expect(sessionAvatars(direct(["user", "deleted-bot"]), bots)).toEqual([
      { id: "deleted-bot", name: null, src: null },
    ]);
  });

  test("missing or invalid avatars retain the Bot's name for a letter fallback", () => {
    for (const avatar of [null, undefined, "", "invalid"]) {
      const withoutAvatar = new Map([[writer.id, { ...writer, avatar }]]);
      expect(sessionAvatars(direct(["user", "writer"]), withoutAvatar)).toEqual([
        { id: "writer", name: "Writer", src: null },
      ]);
    }
  });

  test("profile updates change the derived name and avatar without changing the session", () => {
    const session = direct(["user", "writer"]);
    const updated = new Map(bots);
    updated.set("writer", { ...writer, name: "Editor", avatar: reviewer.avatar });
    expect(sessionAvatars(session, updated)).toEqual([
      { id: "writer", name: "Editor", src: reviewer.avatar },
    ]);
  });
});

describe("compositeAvatarLayout", () => {
  const item = (name: string) => ({ id: name.toLowerCase(), name, src: null });

  test("0 members produces empty fallback layout", () => {
    expect(compositeAvatarLayout([])).toEqual({
      layout: "empty",
      visible: [],
      overflowCount: 0,
      overflowNames: [],
    });
  });

  test("1 member produces single avatar layout", () => {
    const a = item("Alice");
    expect(compositeAvatarLayout([a])).toEqual({
      layout: "single",
      visible: [a],
      overflowCount: 0,
      overflowNames: [],
    });
  });

  test("2 members produce pair layout (diagonal overlap)", () => {
    const a = item("Alice");
    const b = item("Bob");
    expect(compositeAvatarLayout([a, b])).toEqual({
      layout: "pair",
      visible: [a, b],
      overflowCount: 0,
      overflowNames: [],
    });
  });

  test("3 members produce triad layout (triangular cluster matching reference image)", () => {
    const a = item("Alice");
    const b = item("Bob");
    const c = item("Charlie");
    expect(compositeAvatarLayout([a, b, c])).toEqual({
      layout: "triad",
      visible: [a, b, c],
      overflowCount: 0,
      overflowNames: [],
    });
  });

  test("4 members produce quad layout (2x2 cluster with all 4 visible)", () => {
    const a = item("Alice");
    const b = item("Bob");
    const c = item("Charlie");
    const d = item("Dave");
    expect(compositeAvatarLayout([a, b, c, d])).toEqual({
      layout: "quad",
      visible: [a, b, c, d],
      overflowCount: 0,
      overflowNames: [],
    });
  });

  test("5 members produce quad layout with 3 visible and +2 overflow counter", () => {
    const a = item("Alice");
    const b = item("Bob");
    const c = item("Charlie");
    const d = item("Dave");
    const e = item("Eve");
    expect(compositeAvatarLayout([a, b, c, d, e])).toEqual({
      layout: "quad",
      visible: [a, b, c],
      overflowCount: 2,
      overflowNames: ["Dave", "Eve"],
    });
  });

  test("many members (8) produce quad layout with +5 overflow counter", () => {
    const bots = ["A", "B", "C", "D", "E", "F", "G", "H"].map(item);
    expect(compositeAvatarLayout(bots)).toEqual({
      layout: "quad",
      visible: bots.slice(0, 3),
      overflowCount: 5,
      overflowNames: ["D", "E", "F", "G", "H"],
    });
  });
});
