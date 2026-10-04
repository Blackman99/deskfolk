import { expect, test } from "bun:test";
import { COPY } from "./copy.ts";

// copy.ts reads the platform once, when it loads, and test-setup.ts pins the navigator to the
// Mac. The Windows wording needs its own instance of the module, loaded under a Win32 navigator.
async function copyOn(platform: string): Promise<typeof COPY> {
  Object.defineProperty(navigator, "platform", { configurable: true, value: platform });
  try {
    return (await import(`./copy.ts?platform=${platform}`)).COPY;
  } finally {
    Object.defineProperty(navigator, "platform", { configurable: true, value: "MacIntel" });
  }
}

const routineHints = (copy: typeof COPY) => [
  copy.zh.routines.zone,
  copy.zh.routines.availability,
  copy.zh.calendar.projectionHint,
  copy.zh.calendar.lastFiredHostOnly,
  copy.en.routines.zone,
  copy.en.routines.availability,
  copy.en.calendar.projectionHint,
  copy.en.calendar.lastFiredHostOnly,
];

test("on a Mac the routine hints still name the Mac, word for word", () => {
  expect(routineHints(COPY)).toEqual([
    "按执行 Mac 的本地时区运行，不按此浏览器的时区换算。",
    "执行 Mac 需醒着且运行时可用；恢复时只补最近一次，不逐次补跑。归档 Bot 不执行日程。",
    "格子是规则展开，不是每次运行的记录。标出的应跑点只在这台 Mac 上可信。",
    "应跑点标记只在执行 Mac 上显示。格子上的钟点就是那台 Mac 的本地时间。",
    "Runs in the execution Mac’s local time zone, not this browser’s time zone.",
    "The Mac must be awake with the runtime available. On recovery, only the latest missed occurrence is caught up. Archived Bots do not run routines.",
    "A block is the rule unfolded, not a record of each run. A marked due time is only trustworthy on this Mac.",
    "Due marks show only on the execution Mac. The clock on a block is that Mac’s local time.",
  ]);
});

test("on Windows the routine hints name the computer that runs them, not a Mac", async () => {
  const windows = await copyOn("Win32");
  for (const hint of routineHints(windows)) expect(hint).not.toContain("Mac");
  expect(windows.zh.routines.zone).toBe("按执行电脑的本地时区运行，不按此浏览器的时区换算。");
  expect(windows.en.calendar.lastFiredHostOnly).toBe(
    "Due marks show only on the execution computer. The clock on a block is that computer’s local time.",
  );
});

const remoteHostCopy = (copy: typeof COPY) => [
  copy.zh.remote.hostPairEmpty,
  copy.zh.remote.hostPairDone,
  copy.zh.remote.hostConnectIntro,
  copy.zh.remote.relayGuideLead,
  copy.zh.remote.relayGuideFill,
  copy.zh.screen.macToggle,
  copy.zh.screen.macToggleDesc,
  copy.zh.screen.macIceServersDesc,
  copy.zh.screen.macActive("Pixel", "直连"),
  copy.en.remote.hostPairEmpty,
  copy.en.remote.hostPairDone,
  copy.en.remote.hostConnectIntro,
  copy.en.remote.hostConnectFailed,
  copy.en.remote.relayGuideLead,
  copy.en.remote.relayGuideFill,
  copy.en.screen.macToggle,
  copy.en.screen.macToggleDesc,
  copy.en.screen.macIceServersDesc,
  copy.en.screen.macActive("Pixel", "Direct"),
];

test("the window's remote-access and remote-screen words name the Mac there, and the computer on Windows", async () => {
  expect(COPY.zh.remote.hostPairEmpty).toBe("还没有设备配对到这台 Mac。");
  expect(COPY.zh.remote.relayGuideLead).toContain("：Mac 只往外连它");
  expect(COPY.zh.screen.macActive("Pixel", "直连")).toBe("Pixel 正在看这台 Mac 的屏幕（直连）");
  expect(COPY.en.screen.macToggle).toBe("Allow viewing and controlling this Mac's screen");
  const windows = await copyOn("Win32");
  for (const line of remoteHostCopy(windows)) expect(line).not.toContain("Mac");
  expect(windows.zh.screen.macToggle).toBe("允许看和操作这台电脑的屏幕");
  expect(windows.zh.screen.macSharingSettings).toBe("下载 TightVNC");
  expect(windows.en.screen.macSharingOff).toBe("No VNC server found: the phone cannot connect");
});
