import type { CopyShape } from "./shape.ts";

export const zh = {
  message: "连不上运行时",
  host: "执行主机不可达",
  connecting: "正在连接运行时…",
  connectingHost: "正在连接执行主机…",
  retry: "重试",
  hostHint: "任务仍只在已唤醒的 Mac 上执行。不会排队离线命令。",
};

export const en: CopyShape<typeof zh> = {
  message: "Can't reach the runtime",
  host: "Execution host unreachable",
  connecting: "Connecting to the runtime…",
  connectingHost: "Connecting to the execution host…",
  retry: "Try again",
  hostHint: "Work still runs only on the awake Mac. Commands are not queued offline.",
};
