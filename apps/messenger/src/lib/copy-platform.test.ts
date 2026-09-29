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
