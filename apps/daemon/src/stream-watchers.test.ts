import { expect, test } from "bun:test";
import { createLocalApi } from "./local-api";
import { memoryKeyStore } from "./secrets";
import { Store } from "./store";

function api() {
  return createLocalApi({
    store: new Store({ endpointKey: memoryKeyStore("sk-test") }),
    token: "fixture",
    schedule: false,
    completions: {
      async complete() { throw new Error("no turns here"); },
      async judge() { throw new Error("no turns here"); },
    },
  });
}

test("a watcher who joins late is handed the backlog alone; the ones already watching are not", () => {
  // Handed to everyone, it reached a phone already past those bytes as if they were new: its
  // frame claimed the phone's offset and carried the whole ring.
  const local = api();
  const heard: Array<{ watchers: readonly string[]; offset: number; length: number }> = [];
  local.subscribeStreams((_id, read, watchers) => heard.push({ watchers, offset: read.offset, length: read.bytes.length }));
  local.streams.open("s1");
  local.watchStream("s1", "phone", 0);
  local.streams.push("s1", new Uint8Array(300));
  local.watchStream("s1", "tablet", 0);
  local.streams.push("s1", new Uint8Array(20));
  expect(heard).toEqual([
    { watchers: ["phone"], offset: 0, length: 300 },
    { watchers: ["tablet"], offset: 0, length: 300 },
    { watchers: ["phone", "tablet"], offset: 300, length: 20 },
  ]);
});
