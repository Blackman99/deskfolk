import { expect, test } from "bun:test";
import {
  columnName,
  MAX_SPREADSHEET_COLUMNS,
  MAX_SPREADSHEET_ROWS,
  MAX_SPREADSHEET_SHEETS,
  readSpreadsheet,
} from "./spreadsheet.ts";

type CellValue = string | number | boolean | Date | {
  formula?: string;
  result?: string | number | boolean | Date;
  richText?: Array<{ text: string }>;
  text?: string;
  hyperlink?: string;
};

type WorkbookLike = {
  addWorksheet(name: string, options?: { state?: "visible" | "hidden" | "veryHidden" }): {
    getCell(row: number, col: number): { value: CellValue; numFmt?: string };
    mergeCells(range: string): void;
  };
  xlsx: { writeBuffer(): Promise<ArrayBuffer> };
};

const excel = (await import("exceljs")) as { Workbook: new () => WorkbookLike };

async function workbookBytes(fill: (book: WorkbookLike) => void): Promise<ArrayBuffer> {
  const book = new excel.Workbook();
  fill(book);
  const written = await book.xlsx.writeBuffer();
  const copy = new Uint8Array(written.byteLength);
  copy.set(new Uint8Array(written));
  return copy.buffer;
}

test("columnName is the zero-based Excel letter", () => {
  expect(columnName(0)).toBe("A");
  expect(columnName(25)).toBe("Z");
  expect(columnName(26)).toBe("AA");
  expect(columnName(MAX_SPREADSHEET_COLUMNS - 1)).toBe("CV");
  expect(() => columnName(-1)).toThrow(RangeError);
});

test("reads visible sheets, including an empty one, and skips hidden sheets", async () => {
  const data = await workbookBytes((book) => {
    const used = book.addWorksheet("Used");
    used.getCell(1, 1).value = "alpha";
    used.getCell(1, 3).value = 12;
    used.getCell(3, 2).value = false;
    book.addWorksheet("Empty");
    const hidden = book.addWorksheet("Secret", { state: "hidden" });
    hidden.getCell(1, 1).value = "nope";
    const very = book.addWorksheet("Buried", { state: "veryHidden" });
    very.getCell(1, 1).value = "also nope";
  });

  const parsed = await readSpreadsheet(data);
  expect(parsed.truncated).toBeUndefined();
  expect(parsed.sheets.map((sheet) => sheet.name)).toEqual(["Used", "Empty"]);
  expect(parsed.sheets[0]).toEqual({
    name: "Used",
    columns: 3,
    truncated: false,
    rows: [
      { number: 1, cells: ["alpha", "", "12"] },
      { number: 3, cells: ["", "false", ""] },
    ],
  });
  expect(parsed.sheets[1]).toEqual({ name: "Empty", columns: 0, truncated: false, rows: [] });
});

test("a sparse huge row stays one row and does not scan the gap", async () => {
  const data = await workbookBytes((book) => {
    const sheet = book.addWorksheet("Sparse");
    sheet.getCell(1, 1).value = "top";
    sheet.getCell(1_048_576, 2).value = "bottom";
  });

  const started = performance.now();
  const parsed = await readSpreadsheet(data);
  expect(performance.now() - started).toBeLessThan(2000);
  expect(parsed.sheets[0]?.truncated).toBe(false);
  expect(parsed.sheets[0]?.rows).toEqual([
    { number: 1, cells: ["top", ""] },
    { number: 1_048_576, cells: ["", "bottom"] },
  ]);
});

test("caps rows, columns and visible sheets", async () => {
  const data = await workbookBytes((book) => {
    const wide = book.addWorksheet("Wide");
    for (let row = 1; row <= MAX_SPREADSHEET_ROWS + 1; row += 1) wide.getCell(row, 1).value = row;
    wide.getCell(1, MAX_SPREADSHEET_COLUMNS + 1).value = "drop-col";
    for (let i = 0; i < MAX_SPREADSHEET_SHEETS + 2; i += 1) {
      const sheet = book.addWorksheet(`S${i}`);
      sheet.getCell(1, 1).value = i;
    }
    const hidden = book.addWorksheet("Hidden extra", { state: "hidden" });
    hidden.getCell(1, 1).value = "ignored";
  });

  const parsed = await readSpreadsheet(data);
  expect(parsed.truncated).toBe(true);
  expect(parsed.sheets).toHaveLength(MAX_SPREADSHEET_SHEETS);
  expect(parsed.sheets[0]?.name).toBe("Wide");
  expect(parsed.sheets[0]?.columns).toBe(MAX_SPREADSHEET_COLUMNS);
  expect(parsed.sheets[0]?.truncated).toBe(true);
  expect(parsed.sheets[0]?.rows).toHaveLength(MAX_SPREADSHEET_ROWS);
  expect(parsed.sheets[0]?.rows[0]?.cells[0]).toBe("1");
  expect(parsed.sheets[0]?.rows[0]?.cells).toHaveLength(MAX_SPREADSHEET_COLUMNS);
  expect(parsed.sheets[0]?.rows.at(-1)?.number).toBe(MAX_SPREADSHEET_ROWS);
  expect(parsed.sheets[0]?.rows.at(-1)?.cells[0]).toBe(String(MAX_SPREADSHEET_ROWS));
  expect(parsed.sheets.at(-1)?.name).toBe(`S${MAX_SPREADSHEET_SHEETS - 2}`);
});

test("values beyond column CV are omitted with a truncation notice, including sparse sheets", async () => {
  const data = await workbookBytes((book) => {
    const sheet = book.addWorksheet("Sparse columns");
    sheet.getCell(1, 101).value = "outside-preview";
  });
  const sheet = (await readSpreadsheet(data)).sheets[0]!;
  expect(sheet.columns).toBe(100);
  expect(sheet.truncated).toBe(true);
  expect(sheet.rows[0]?.cells.every((cell) => cell === "")).toBe(true);
  expect(sheet.rows[0]?.cells).not.toContain("outside-preview");
});

test("dates, cached and uncached formulas, rich text and hyperlinks are plain text", async () => {
  const data = await workbookBytes((book) => {
    const sheet = book.addWorksheet("Values");
    const day = sheet.getCell(1, 1);
    day.value = new Date(Date.UTC(2024, 2, 5));
    day.numFmt = "yyyy-mm-dd";
    const clock = sheet.getCell(1, 2);
    clock.value = new Date(Date.UTC(2024, 2, 5, 15, 4, 5));
    clock.numFmt = "yyyy-mm-dd hh:mm:ss";
    sheet.getCell(2, 1).value = { formula: "1+1", result: 2 };
    sheet.getCell(2, 2).value = { formula: "A1+A2", result: 0 };
    sheet.getCell(2, 3).value = { formula: "NOW()" };
    sheet.getCell(3, 1).value = { richText: [{ text: "bold " }, { text: "tail" }] };
    sheet.getCell(3, 2).value = { text: "deskfolk", hyperlink: "https://example.test/sheet" };
    sheet.mergeCells("A4:B4");
    sheet.getCell(4, 1).value = "merged";
  });

  const parsed = await readSpreadsheet(data);
  const rows = parsed.sheets[0]?.rows ?? [];
  expect(rows[0]?.cells.slice(0, 2)).toEqual(["2024-03-05", "2024-03-05T15:04:05.000Z"]);
  expect(rows[1]?.cells.slice(0, 3)).toEqual(["2", "0", "=NOW()"]);
  expect(rows[2]?.cells.slice(0, 2)).toEqual(["bold tail", "deskfolk"]);
  expect(rows[2]?.cells.join(" ")).not.toContain("https://");
  expect(rows[3]?.cells.slice(0, 2)).toEqual(["merged", "merged"]);
});
