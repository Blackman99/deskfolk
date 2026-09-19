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
