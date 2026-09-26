import { afterEach, expect, test } from "bun:test";
import { flushSync } from "svelte";
import { strToU8 } from "fflate";
import { click, render } from "../test-render.ts";
import { reactive } from "../test-reactive.svelte.ts";
import { OFFICE_MAX_BYTES } from "./office/archive.ts";
import OfficeViewer from "./OfficeViewer.svelte";
import { closeFullscreenPreview } from "./fullscreen-preview.ts";

const labels = {
  readOnly: "只读预览",
  fullscreen: "全屏预览",
  exitFull: "退出全屏（Esc）",
  loading: "正在解析办公文件…",
  failed: "无法预览这份文件。请确认文件完整且未加密，或用系统应用打开。",
  tooLarge: "文件超过预览容量限制，请用系统应用打开（文件上限 50 MiB，解压后 128 MiB）。",
  retry: "重试",
  previous: "上一张幻灯片",
  next: "下一张幻灯片",
  sheets: "工作表",
  row: "行号",
  emptySheet: "这张工作表没有单元格数据。",
  empty: "没有可预览的内容。",
  truncated: "已限制为前 50 张可见工作表，每张最多 1000 个有数据的行、100 列。",
  sheetHint: "显示单元格内容与公式的已存结果；公式未存结果时显示公式。图表、图片和原始排版请用系统应用查看。",
  layoutHint: "字体与复杂排版可能有差异；动画、宏和外部链接保持停用。",
};

type WorkbookLike = {
  addWorksheet(name: string): {
    getCell(row: number, col: number): { value: string | number };
  };
  xlsx: { writeBuffer(): Promise<ArrayBuffer> };
};

const excel = (await import("exceljs")) as { Workbook: new () => WorkbookLike };
const mounted: Array<{ close: () => void }> = [];

afterEach(() => {
  for (const view of mounted) view.close();
  mounted.length = 0;
});

async function workbook(fill: (book: WorkbookLike) => void): Promise<Blob> {
  const book = new excel.Workbook();
  fill(book);
  const written = await book.xlsx.writeBuffer();
  const copy = new Uint8Array(written.byteLength);
  copy.set(new Uint8Array(written));
  return new Blob([copy], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
}

function mount(props: { data: Blob; kind: "word" | "spreadsheet" | "presentation"; title?: string }) {
  const view = render(OfficeViewer, {
    get data() {
      return props.data;
    },
    get kind() {
      return props.kind;
    },
    title: props.title ?? "report.xlsx",
    labels,
  });
  let closed = false;
  const once = {
    host: view.host,
    close() {
      if (closed) return;
      closed = true;
      view.close();
    },
  };
  mounted.push(once);
  return once;
}

async function settled(host: HTMLElement, text: string): Promise<void> {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    flushSync();
    if (host.textContent?.includes(text)) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for ${text}`);
}

test("a real workbook shows literal cells and switches worksheets", async () => {
  const data = await workbook((book) => {
    const first = book.addWorksheet("Used");
    first.getCell(1, 1).value = "alpha";
    first.getCell(1, 2).value = 12;
    book.addWorksheet("Empty");
  });
  const { host } = mount({ data, kind: "spreadsheet" });

  await settled(host, "alpha");
  expect(host.textContent).toContain("只读预览");
  expect(host.textContent).toContain("Excel");
  expect(host.textContent).toContain("alpha");
  expect(host.textContent).toContain("12");
  expect(host.querySelector("a, button[download], input, textarea")).toBeNull();

  click([...host.querySelectorAll("button")].find((button) => button.textContent === "Empty"));
  await settled(host, labels.emptySheet);
  expect(host.textContent).not.toContain("alpha");
});

test("a corrupted package says so and retry asks again", async () => {
  let reads = 0;
  const data = new Blob([strToU8("not a workbook")]);
  const original = data.arrayBuffer.bind(data);
  data.arrayBuffer = () => {
    reads += 1;
    return original();
  };
  const { host } = mount({ data, kind: "spreadsheet", title: "broken.xlsx" });

  await settled(host, labels.failed);
  expect(host.querySelector("[role='alert']")?.textContent).toContain(labels.failed);
  expect(host.textContent).not.toContain(labels.tooLarge);

  click([...host.querySelectorAll("button")].find((button) => button.textContent === labels.retry));
  await settled(host, labels.failed);
  expect(reads).toBe(2);
});

test("a blob over 50 MiB is refused without being read", async () => {
  let reads = 0;
  const data = new Blob([new Uint8Array(OFFICE_MAX_BYTES + 1)]);
  data.arrayBuffer = () => {
    reads += 1;
    return Promise.resolve(new ArrayBuffer(0));
  };
  const { host } = mount({ data, kind: "spreadsheet" });

  await settled(host, labels.tooLarge);
  expect(host.textContent).not.toContain(labels.retry);
  expect(reads).toBe(0);
});

function hold(blob: Blob): { blob: Blob; opened: Promise<void>; release: () => void } {
  let release = () => {};
  const opened = new Promise<void>((resolve) => {
    const read = blob.arrayBuffer.bind(blob);
    blob.arrayBuffer = () => new Promise((done) => {
      resolve();
      release = () => done(read());
    });
  });
  return { blob, opened, release: () => release() };
}

test("replacing the blob or unmounting drops a stale workbook", async () => {
  const first = hold(await workbook((book) => {
    book.addWorksheet("Old").getCell(1, 1).value = "stale-cell";
  }));
  const second = await workbook((book) => {
    book.addWorksheet("New").getCell(1, 1).value = "fresh-cell";
  });
  const props = reactive({ data: first.blob, kind: "spreadsheet" as const, title: "swap.xlsx", labels });
  const { host, close } = mount(props);
  await first.opened;

  flushSync(() => {
    props.data = second;
  });
  first.release();
  await settled(host, "fresh-cell");
  expect(host.textContent).not.toContain("stale-cell");

  const late = hold(await workbook((book) => {
    book.addWorksheet("Late").getCell(1, 1).value = "after-close";
  }));
  props.data = late.blob;
  flushSync();
  await late.opened;
  close();
  late.release();
  await new Promise((resolve) => setTimeout(resolve, 30));
  flushSync();
  expect(host.isConnected).toBe(false);
  expect(document.body.textContent).not.toContain("after-close");
});

test("the same file handed down through a re-derived parent keeps the open document", async () => {
  const data = await workbook((book) => {
    book.addWorksheet("First").getCell(1, 1).value = "first-cell";
    book.addWorksheet("Second").getCell(1, 1).value = "second-cell";
  });
  let reads = 0;
  const read = data.arrayBuffer.bind(data);
  data.arrayBuffer = () => { reads++; return read(); };
  // A pane rebuilds the object it hands the path down in whenever another pane switches
  // conversations: a new object, the same path.
  const pane = reactive({ preview: { relpath: "report.xlsx" } });
  const view = render(OfficeViewer, {
    data,
    kind: "spreadsheet",
    get title() {
      return pane.preview.relpath;
    },
    labels,
  });
  mounted.push({ close: view.close });
  await settled(view.host, "first-cell");
  click([...view.host.querySelectorAll("button")].find((button) => button.textContent === "Second"));
  await settled(view.host, "second-cell");

  flushSync(() => {
    pane.preview = { relpath: "report.xlsx" };
  });
  await new Promise((resolve) => setTimeout(resolve, 30));
  flushSync();
  expect(reads).toBe(1);
  expect(view.host.textContent).toContain("second-cell");
  expect(view.host.textContent).not.toContain(labels.loading);
});

test("read-only preview never offers a save of the workbook", async () => {
  const data = await workbook((book) => {
    book.addWorksheet("Used").getCell(1, 1).value = "kept";
  });
  const { host } = mount({ data, kind: "spreadsheet" });
  await settled(host, "kept");
  const labelled = [...host.querySelectorAll("button, a")].map((node) => node.textContent ?? "");
  expect(labelled.join(" ")).not.toMatch(/保存|下载|save|download/i);
  expect(host.querySelector("[download]")).toBeNull();
});

test("full-screen toggle and Escape preserve the active worksheet and parsed workbook", async () => {
  const data = await workbook((book) => {
    book.addWorksheet("First").getCell(1, 1).value = "first-cell";
    book.addWorksheet("Second").getCell(1, 1).value = "second-cell";
  });
  let reads = 0;
  const read = data.arrayBuffer.bind(data);
  data.arrayBuffer = () => { reads++; return read(); };
  const { host } = mount({ data, kind: "spreadsheet" });
  await settled(host, "first-cell");
  click([...host.querySelectorAll("button")].find((button) => button.textContent === "Second"));
  const root = host.querySelector<HTMLElement>(".office-viewer")!;
  const button = host.querySelector<HTMLButtonElement>(".office-full")!;
  let opened = 0;
  let closed = 0;
  root.showPopover = () => { opened++; };
  root.hidePopover = () => { closed++; };
  click(button);
  expect(root.classList.contains("is-enlarged")).toBe(true);
  expect(root.getAttribute("popover")).toBe("manual");
  expect(button.getAttribute("aria-label")).toBe(labels.exitFull);
  expect(root.textContent).toContain("second-cell");
  expect(root.textContent).toContain("report.xlsx");
  click(button);
  expect(root.classList.contains("is-enlarged")).toBe(false);
  expect(root.hasAttribute("popover")).toBe(false);
  expect(button.getAttribute("aria-label")).toBe(labels.fullscreen);
  expect(document.activeElement).toBe(button);
  click(button);
  const escape = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
  button.dispatchEvent(escape);
  flushSync();
  expect(escape.defaultPrevented).toBe(true);
  expect(root.classList.contains("is-enlarged")).toBe(false);
  expect(root.textContent).toContain("second-cell");
  expect(reads).toBe(1);
  expect(opened).toBe(2);
  expect(closed).toBe(2);
});

test("in full screen a click in the document hands focus back, so Escape still leaves and copy still copies", async () => {
  const data = await workbook((book) => book.addWorksheet("First").getCell(1, 1).value = "first-cell");
  const { host } = mount({ data, kind: "spreadsheet" });
  await settled(host, "first-cell");
  const root = host.querySelector<HTMLElement>(".office-viewer")!;
  root.showPopover = () => {};
  root.hidePopover = () => {};
  // Stands in for a Word or PowerPoint frame: keys pressed in it never reach the messenger.
  const frame = document.createElement("iframe");
  host.querySelector(".office-document")!.appendChild(frame);
  const inside = frame.contentDocument!;
  inside.body.textContent = "selected words";
  const range = inside.createRange();
  range.selectNodeContents(inside.body);
  inside.getSelection()!.addRange(range);
  click(host.querySelector(".office-full"));
  expect(root.classList.contains("is-enlarged")).toBe(true);

  frame.focus();
  expect(document.activeElement).toBe(frame);
  window.dispatchEvent(new Event("blur"));
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(document.activeElement).toBe(root);

  const copied = new ClipboardEvent("copy", { bubbles: true, cancelable: true, clipboardData: new DataTransfer() });
  root.dispatchEvent(copied);
  expect(copied.defaultPrevented).toBe(true);
  expect(copied.clipboardData?.getData("text/plain")).toBe("selected words");

  const escape = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
  root.dispatchEvent(escape);
  flushSync();
  expect(escape.defaultPrevented).toBe(true);
  expect(root.classList.contains("is-enlarged")).toBe(false);
});

test("switching files and unmounting remove the full-screen layer and Escape listener", async () => {
  const data = await workbook((book) => book.addWorksheet("First").getCell(1, 1).value = "first-cell");
  const next = await workbook((book) => book.addWorksheet("Next").getCell(1, 1).value = "next-cell");
  const props = reactive({ data, kind: "spreadsheet" as const });
  const { host, close } = mount(props);
  await settled(host, "first-cell");
  const root = host.querySelector<HTMLElement>(".office-viewer")!;
  const button = host.querySelector<HTMLButtonElement>(".office-full")!;
  let hidden = 0;
  root.showPopover = () => {};
  root.hidePopover = () => { hidden++; };
  click(button);
  props.data = next;
  await settled(host, "next-cell");
  expect(root.classList.contains("is-enlarged")).toBe(false);
  expect(root.hasAttribute("popover")).toBe(false);
  click(button);
  close();
  expect(hidden).toBe(2);
  expect(closeFullscreenPreview()).toBe(false);
  const escape = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
  document.dispatchEvent(escape);
  expect(escape.defaultPrevented).toBe(false);
});

test("a refused popover keeps the preview usable and its full-screen state off", async () => {
  const { host } = mount({ data: new Blob(["invalid"]), kind: "word" });
  await settled(host, labels.failed);
  const root = host.querySelector<HTMLElement>(".office-viewer")!;
  root.showPopover = () => { throw new Error("unavailable"); };
  click(host.querySelector(".office-full"));
  expect(root.classList.contains("is-enlarged")).toBe(false);
  expect(root.hasAttribute("popover")).toBe(false);
  expect(host.textContent).toContain(labels.failed);
  expect(closeFullscreenPreview()).toBe(false);
});
