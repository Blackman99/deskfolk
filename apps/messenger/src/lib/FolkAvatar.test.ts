import { expect, test } from "bun:test";
import { folkLayerSrc, folkLook, generateBoringAvatar, hashCode } from "@real-bot/protocol";
import FolkAvatar from "./FolkAvatar.svelte";
import { render } from "./test-render.ts";

const names = Array.from({ length: 60 }, (_, i) => `Bot ${i}`);

function mount(name: string, motion?: string) {
  return render(FolkAvatar as never, { avatar: generateBoringAvatar({ name }), motion } as never);
}

test("it stacks the layers its picture is drawn from, plus closed eyes and an open mouth to move", () => {
  const name = names.find((n) => folkLook(hashCode(n)).accessory)!;
  const look = folkLook(hashCode(name));
  const { host, close } = mount(name);
  const srcs = [...host.querySelectorAll("img")].map((img) => img.getAttribute("src"));
  expect(srcs).toEqual([
    folkLayerSrc("body"),
    folkLayerSrc("arm-l"),
    folkLayerSrc("arm-r"),
    folkLayerSrc(`eyes-${look.eyes}`),
    folkLayerSrc("eyes-closed"),
    folkLayerSrc(`mouth-${look.mouth}`),
    folkLayerSrc("mouth-open"),
    folkLayerSrc(`acc-${look.accessory!}`),
  ]);
  expect(host.querySelector(".folk")?.getAttribute("aria-hidden")).toBe("true");
  close();
});

test("each motion marks the folk, and only thinking, failing and sleeping draw something over it", () => {
  const marks: Record<string, string | null> = {
    idle: null,
    running: ".folk-dot",
    replying: null,
    waiting: null,
    failed: ".folk-sweat",
    held: ".folk-z",
  };
  for (const [motion, mark] of Object.entries(marks)) {
    const { host, close } = mount("Writer", motion);
    expect(host.querySelector(".folk")?.classList.contains(`is-${motion}`)).toBe(true);
    expect(host.querySelector(".folk-mark") !== null).toBe(mark !== null);
    if (mark) expect(host.querySelector(mark)).not.toBeNull();
    close();
  }
});

test("mirroring and a raised hand follow the name, as in the still picture", () => {
  const mirrored = names.find((n) => folkLook(hashCode(n)).mirror)!;
  const straight = names.find((n) => !folkLook(hashCode(n)).mirror)!;
  const raised = names.find((n) => folkLook(hashCode(n)).wave)!;
  for (const [name, cls, expected] of [
    [mirrored, "is-mirrored", true],
    [straight, "is-mirrored", false],
    [raised, "has-raised-arm", true],
  ] as const) {
    const { host, close } = mount(name);
    expect(host.querySelector(".folk")?.classList.contains(cls)).toBe(expected);
    close();
  }
});
