import { expect, test } from "nsh/test";
import { trayMenu } from "./linux-tray";

const noop = { show: () => {}, usage: () => {}, stop: () => {}, quit: () => {} };

test("the Linux tray has the usage lines, then Show, Stop Everything and Quit", () => {
  const menu = trayMenu([{ text: "Claude 5h 10%", all: false }, { text: "查看全部用量…", all: true }], true, noop).filter(Boolean);
  const labels = menu.map((item) => ("label" in (item as object) ? (item as { label: string }).label : "—"));
  expect(labels).toEqual(["Claude 5h 10%", "查看全部用量…", "—", "Show Deskfolk", "Stop Everything", "—", "Quit Deskfolk"]);
});

test("Stop Everything waits for the runtime to answer", () => {
  const stop = trayMenu([], false, noop).filter(Boolean).find((item) => (item as { label?: string }).label === "Stop Everything") as { disabled: boolean };
  expect(stop.disabled).toBe(true);
});
