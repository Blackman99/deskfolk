import { expect, test } from "bun:test";
import { click, render } from "./test-render.ts";
import MarkdownBody from "./MarkdownBody.svelte";

const labels = { copyLabel: "复制代码", copiedLabel: "已复制" };

test("a GFM table keeps table markup with a header row and cells", () => {
  const { host, close } = render(MarkdownBody, {
    ...labels,
    source: ["| 镜号 | 判 | 依据 |", "| --- | --- | --- |", "| 1A | 本轮可作 | 侧视四人 |", "| 2A | 未过 | 下栏墨镜仍是像素 |"].join(
      "\n",
    ),
  });
  const table = host.querySelector("table");
  expect(table).toBeTruthy();
  expect(table?.parentElement?.classList.contains("md-table-wrap")).toBe(true);
  expect(getComputedStyle(table!).display).toBe("table");
  expect(getComputedStyle(table!).borderCollapse).toBe("collapse");
  const firstRow = host.querySelector("tbody tr") ?? host.querySelector("tr:nth-child(2)");
  expect(firstRow?.querySelectorAll("td")).toHaveLength(3);
  const headers = [...host.querySelectorAll("th")].map((el) => el.textContent?.trim());
  expect(headers).toEqual(["镜号", "判", "依据"]);
  expect(host.querySelectorAll("td")).toHaveLength(6);
  expect(host.querySelector(".md-body")).toBeTruthy();
  close();
});

/** wrap-anywhere + width:100% in a fit-content bubble turns short CJK headers into a column of one character. */
test("a dense table keeps short headers on one line and scrolls instead of wrapping every character", () => {
  const { host, close } = render(MarkdownBody, {
    ...labels,
    source: [
      "| 序号 | 题材类型 | 片名暂定 | 核心戏剧高概念 |",
      "| --- | --- | --- | --- |",
      "| 方案 A | 科幻悬疑 | 《第七次唤醒》 | 一名孤身驻守在深空观测站的女工程师 |",
    ].join("\n"),
  });
  const wrap = host.querySelector(".md-table-wrap") as HTMLElement;
  const table = host.querySelector("table") as HTMLTableElement;
  const header = host.querySelector("th") as HTMLElement;
  const cell = host.querySelector("td") as HTMLElement;
  expect(getComputedStyle(wrap).overflowX).toBe("auto");
  expect(getComputedStyle(table).width).toBe("max-content");
  expect(getComputedStyle(table).minWidth).toBe("100%");
  expect(getComputedStyle(header).whiteSpace).toBe("nowrap");
  expect(getComputedStyle(cell).overflowWrap).toBe("break-word");
  expect(getComputedStyle(cell).wordBreak).toBe("normal");
  close();
});

test("headings lists and inline code match the shared renderer", () => {
  const { host, close } = render(MarkdownBody, {
    ...labels,
    source: "## 相对 V2.6\n\n- 一项\n- 二项\n\n用 `LOCK` 对照。",
  });
  expect(host.querySelector("h2")?.textContent).toBe("相对 V2.6");
  expect(host.querySelectorAll("li")).toHaveLength(2);
  expect(host.querySelector("code")?.textContent).toBe("LOCK");
  close();
});

test("inverted paints the user-bubble class", () => {
  const { host, close } = render(MarkdownBody, {
    ...labels,
    source: "hi",
    inverted: true,
  });
  expect(host.querySelector(".md-body")?.classList.contains("is-inverted")).toBe(true);
  close();
});

test("an artifact link calls onOpenArtifact and does not leave the page", () => {
  const opened: string[] = [];
  const { host, close } = render(MarkdownBody, {
    ...labels,
    source: "见 [核边数据.txt](inbox/核边数据.txt)",
    onOpenArtifact: (path: string) => opened.push(path),
  });
  const a = host.querySelector("a");
  expect(a).toBeTruthy();
  click(a);
  expect(opened).toEqual(["inbox/核边数据.txt"]);
  close();
});

test("standalone attachment links are hidden when a bundle entry is shown", () => {
  const { host, close } = render(MarkdownBody, {
    ...labels,
    source: [
      "正文里的 [核边数据](inbox/核边数据.txt) 要保留。",
      "",
      "[inbox/核边数据.txt](inbox/核边数据.txt)  ",
      "[inbox/sources](inbox/sources)",
    ].join("\n"),
    hideStandaloneArtifactLinks: ["inbox/核边数据.txt", "inbox/sources"],
  });
  const links = [...host.querySelectorAll("a")].map((anchor) => anchor.textContent);
  expect(links).toEqual(["核边数据"]);
  expect(host.textContent).not.toContain("inbox/sources");
  expect(host.querySelectorAll("br")).toHaveLength(0);
  close();
});

test("attachment links remain visible without a bundle entry", () => {
  const { host, close } = render(MarkdownBody, {
    ...labels,
    source: "[inbox/核边数据.txt](inbox/核边数据.txt)",
  });
  expect(host.querySelector("a")?.textContent).toBe("inbox/核边数据.txt");
  close();
});

test("an artifact image link becomes a thumbnail and opens the preview", async () => {
  const opened: string[] = [];
  const created: string[] = [];
  const revoked: string[] = [];
  const originalCreate = URL.createObjectURL;
  const originalRevoke = URL.revokeObjectURL;
  URL.createObjectURL = ((blob: Blob) => {
    created.push(blob.type);
    return "blob:inline-thumb";
  }) as typeof URL.createObjectURL;
  URL.revokeObjectURL = ((url: string) => revoked.push(url)) as typeof URL.revokeObjectURL;
  try {
    const { host, close } = render(MarkdownBody, {
      ...labels,
      source: "本地图片：[avatar_artist_bot.jpg](avatar_artist_bot.jpg)",
      onOpenArtifact: (path: string) => opened.push(path),
      loadArtifactImage: async () => new Blob(["image"], { type: "image/jpeg" }),
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const anchor = host.querySelector("a.md-artifact-image");
    const image = anchor?.querySelector("img.md-artifact-thumb") as HTMLImageElement | null;
    expect(anchor?.getAttribute("data-artifact-image")).toBe("ready");
    expect(image?.src).toBe("blob:inline-thumb");
    expect(created).toEqual(["image/jpeg"]);
    click(anchor);
    expect(opened).toEqual(["avatar_artist_bot.jpg"]);
    close();
    expect(revoked).toEqual(["blob:inline-thumb"]);
  } finally {
    URL.createObjectURL = originalCreate;
    URL.revokeObjectURL = originalRevoke;
  }
});

test("markdown SVG thumbs strip active content before the blob URL", async () => {
  const texts: string[] = [];
  const originalCreate = URL.createObjectURL;
  URL.createObjectURL = ((blob: Blob) => {
    void blob.text().then((text) => texts.push(text));
    return "blob:svg-thumb";
  }) as typeof URL.createObjectURL;
  try {
    const { host, close } = render(MarkdownBody, {
      ...labels,
      source: "[icon.svg](icon.svg)",
      loadArtifactImage: async () => new Blob(["<svg/onload=alert(1)><script src=x>"], { type: "image/svg+xml" }),
    });
    for (let i = 0; i < 20 && texts.length === 0; i++) await new Promise((resolve) => setTimeout(resolve, 1));
    expect(host.querySelector("a.md-artifact-image")?.getAttribute("data-artifact-image")).toBe("ready");
    expect(texts).toHaveLength(1);
    expect(texts[0]!.toLowerCase()).not.toContain("onload");
    expect(texts[0]!.toLowerCase()).not.toContain("<script");
    close();
  } finally {
    URL.createObjectURL = originalCreate;
  }
});

test("a failed artifact thumbnail keeps the original link", async () => {
  const { host, close } = render(MarkdownBody, {
    ...labels,
    source: "[missing.png](missing.png)",
    loadArtifactImage: async () => Promise.reject(new Error("missing")),
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  const anchor = host.querySelector("a");
  expect(anchor?.classList.contains("md-artifact-image")).toBe(false);
  expect(anchor?.textContent).toBe("missing.png");
  close();
});

test("a bot mention chip calls onOpenProfile", () => {
  const opened: string[] = [];
  const { host, close } = render(MarkdownBody, {
    ...labels,
    source: "@审片 请看",
    options: { mentionBots: [{ id: "review-1", name: "审片", avatar: null }] },
    onOpenProfile: (id: string) => opened.push(id),
  });
  expect(host.querySelector(".md-mention-chip")).toBeTruthy();
  click(host.querySelector("a.md-mention-chip"));
  expect(opened).toEqual(["review-1"]);
  close();
});

test("http links open in a new browsing context", () => {
  const opened: string[] = [];
  const original = window.open;
  window.open = ((url?: string | URL) => {
    opened.push(String(url));
    return null;
  }) as typeof window.open;
  try {
    const { host, close } = render(MarkdownBody, {
      ...labels,
      source: "[spec](https://example.com/spec)",
    });
    click(host.querySelector("a"));
    expect(opened).toEqual(["https://example.com/spec"]);
    close();
  } finally {
    window.open = original;
  }
});
