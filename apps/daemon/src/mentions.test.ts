import { describe, expect, test } from "bun:test";
import { parseMentions } from "./mentions";

describe("parseMentions", () => {
  test("longest roster name wins and everyone is literal", () => {
    const parsed = parseMentions("hi @WriterBot and @Writer and @everyone", ["Writer", "WriterBot"]);
    expect(parsed.mentions).toEqual(["WriterBot", "Writer"]);
    expect(parsed.everyone).toBe(true);
    expect(parsed.unresolved).toEqual([]);
  });

  test("unknown names are unresolved and do not create a bot", () => {
    const parsed = parseMentions("@Nope hello", ["Writer"]);
    expect(parsed.mentions).toEqual([]);
    expect(parsed.unresolved).toEqual(["Nope"]);
    expect(parsed.everyone).toBe(false);
  });
});
