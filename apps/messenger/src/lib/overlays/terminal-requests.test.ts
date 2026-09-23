import { expect, test } from "bun:test";
import { silenceRequests } from "./terminal-requests.ts";

type Id = { prefix?: string; intermediates?: string; final: string };

function fakeParser() {
  const csi: Array<{ id: Id; fn: () => boolean }> = [];
  const dcs: Array<{ id: Id; fn: () => boolean }> = [];
  const osc: Array<{ ident: number; fn: (data: string) => boolean }> = [];
  let disposed = 0;
  const handle = { dispose: () => { disposed += 1; } };
  const parser = {
    registerCsiHandler: (id: Id, fn: () => boolean) => { csi.push({ id, fn }); return handle; },
    registerDcsHandler: (id: Id, fn: () => boolean) => { dcs.push({ id, fn }); return handle; },
    registerOscHandler: (ident: number, fn: (data: string) => boolean) => { osc.push({ ident, fn }); return handle; },
  };
  const key = (id: Id) => `${id.prefix ?? ""}${id.intermediates ?? ""}${id.final}`;
  return { parser, csi, dcs, osc, key, disposed: () => disposed };
}

test("while silent, every request xterm would answer is swallowed; otherwise xterm answers", () => {
  const { parser, csi, dcs, key } = fakeParser();
  let replaying = true;
  silenceRequests(parser as never, () => replaying);
  // DA1 is the one that put `1;2c` at the prompt; the rest are the same kind of request.
  expect(csi.map((h) => key(h.id)).sort()).toEqual([">c", ">q", "?$p", "?n", "$p", "=c", "c", "n"].sort());
  expect(dcs.map((h) => key(h.id))).toEqual(["$q"]);
  for (const h of [...csi, ...dcs]) expect(h.fn()).toBe(true);
  replaying = false;
  for (const h of [...csi, ...dcs]) expect(h.fn()).toBe(false);
});

test("a colour query is swallowed, but a colour being set still applies", () => {
  const { parser, osc } = fakeParser();
  silenceRequests(parser as never, () => true);
  const background = osc.find((h) => h.ident === 11)!;
  expect(background.fn("?")).toBe(true);
  expect(background.fn("rgb:1616/1e1e/2b2b")).toBe(false);
  expect(osc.map((h) => h.ident)).toEqual([4, 10, 11, 12]);
});

test("disposing takes every handler off the parser", () => {
  const { parser, csi, dcs, osc, disposed } = fakeParser();
  silenceRequests(parser as never, () => false).dispose();
  expect(disposed()).toBe(csi.length + dcs.length + osc.length);
});
