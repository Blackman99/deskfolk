/**
 * Bounded plain-text view of an .xlsx workbook. ExcelJS is loaded from its browser
 * bundle (`exceljs` package "browser" field) only when a sheet is opened.
 *
 * Rows and columns come from the sparse cells ExcelJS already stored. A value in
 * row 1048576 does not allocate the rows above it. Hidden sheets are left out;
 * an empty visible sheet is kept. Merged slaves repeat the master text — the
 * preview is a plain grid, not HTML.
 */

export const MAX_SPREADSHEET_ROWS = 1000;
export const MAX_SPREADSHEET_COLUMNS = 100;
export const MAX_SPREADSHEET_SHEETS = 50;

export type SpreadsheetRow = {
  /** 1-based worksheet row number. */
  number: number;
  cells: string[];
};

export type SpreadsheetSheet = {
  name: string;
  rows: SpreadsheetRow[];
  /** Columns kept, 1..n, capped at MAX_SPREADSHEET_COLUMNS. */
  columns: number;
  /** True when a value row or column was left out of this sheet. */
  truncated: boolean;
};

export type Spreadsheet = {
  sheets: SpreadsheetSheet[];
  /** True when a visible sheet past the first 50 was left out. */
  truncated?: boolean;
};

import type { Cell, Row, Worksheet } from "exceljs";

type ExcelCell = Cell;
type ExcelRow = Row;
type ExcelWorksheet = Worksheet;
type ValueTypes = typeof import("exceljs").ValueType;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** Zero-based column index to an Excel letter: 0 → A, 25 → Z, 26 → AA. */
export function columnName(index: number): string {
  if (!Number.isInteger(index) || index < 0) {
    throw new RangeError(`column index out of range: ${index}`);
  }
  let name = "";
  let n = index + 1;
  while (n > 0) {
    const rem = (n - 1) % 26;
    name = String.fromCharCode(65 + rem) + name;
    n = Math.floor((n - 1) / 26);
  }
  return name;
}

/** A calendar day is the date alone; a time of day keeps the clock. */
function formatDate(value: Date): string {
  if (Number.isNaN(value.getTime())) return "";
  const iso = value.toISOString();
  return iso.endsWith("T00:00:00.000Z") ? iso.slice(0, 10) : iso;
}

function formatScalar(value: unknown): string {
  if (value == null) return "";
  if (value instanceof Date) return formatDate(value);
  if (typeof value === "string") return value;
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (isRecord(value) && typeof value.error === "string") return value.error;
  return "";
}

function richText(value: unknown): string | null {
  if (!isRecord(value) || !Array.isArray(value.richText)) return null;
  return value.richText
    .map((part) => (isRecord(part) && typeof part.text === "string" ? part.text : ""))
    .join("");
}

function hyperlinkText(value: unknown): string | null {
  if (!isRecord(value) || typeof value.hyperlink !== "string") return null;
  return typeof value.text === "string" ? value.text : "";
}

/**
 * Cached formula result, or `=<formula>` when Excel stored none.
 * `cell.value` drops a result of `0` or `false`; `cell.result` still has it.
 */
function formulaText(cell: ExcelCell): string {
  const value = cell.value;
  const formula = isRecord(value) && typeof value.formula === "string" ? value.formula : cell.formula;
  if (cell.result == null) return formula ? `=${formula}` : "";
  return formatScalar(cell.result);
}

function cellText(cell: ExcelCell, types: ValueTypes): string {
  const value = cell.value;
  if (cell.type === types.Formula) return formulaText(cell);
  if (cell.type === types.RichText) return richText(value) ?? "";
  if (cell.type === types.Hyperlink) return hyperlinkText(value) ?? cell.text;
  if (cell.type === types.Date && value instanceof Date) return formatDate(value);
  if (cell.type === types.Error) return formatScalar(value);
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean" || value instanceof Date) {
    return formatScalar(value);
  }
  return cell.text;
}

function sheetColumns(rows: ExcelRow[]): { columns: number; truncated: boolean } {
  let max = 0;
  let truncated = false;
  for (const row of rows) {
    const width = row.cellCount;
    if (width > MAX_SPREADSHEET_COLUMNS) truncated = true;
    if (width > max) max = width;
  }
  return { columns: Math.min(max, MAX_SPREADSHEET_COLUMNS), truncated };
}

function readRow(row: ExcelRow, columns: number, types: ValueTypes): { cells: string[]; truncated: boolean } {
  const cells = Array.from({ length: columns }, () => "");
  let truncated = false;
  row.eachCell((cell, colNumber) => {
    if (colNumber > columns) {
      truncated = true;
      return;
    }
    cells[colNumber - 1] = cellText(cell, types);
  });
  return { cells, truncated };
}

function readSheet(sheet: ExcelWorksheet, types: ValueTypes): SpreadsheetSheet {
  const kept: ExcelRow[] = [];
  let count = 0;
  sheet.eachRow((row) => {
    count++;
    if (kept.length < MAX_SPREADSHEET_ROWS) kept.push(row);
  });
  const width = sheetColumns(kept);
  const rows: SpreadsheetRow[] = [];
  let truncated = width.truncated || count > MAX_SPREADSHEET_ROWS;
  for (const row of kept) {
    const read = readRow(row, width.columns, types);
    if (read.truncated) truncated = true;
    rows.push({ number: row.number, cells: read.cells });
  }
  return { name: sheet.name, rows, columns: width.columns, truncated };
}

/** Parse `data` into at most 50 visible sheets, 1000 rows and 100 columns each. */
export async function readSpreadsheet(data: ArrayBuffer): Promise<Spreadsheet> {
  const excel = (await import("exceljs")).default;
  const workbook = new excel.Workbook();
  await workbook.xlsx.load(data);
  const visible = workbook.worksheets.filter((sheet) => sheet.state === "visible");
  return {
    sheets: visible.slice(0, MAX_SPREADSHEET_SHEETS).map((sheet) => readSheet(sheet, excel.ValueType)),
    ...(visible.length > MAX_SPREADSHEET_SHEETS ? { truncated: true } : {}),
  };
}
