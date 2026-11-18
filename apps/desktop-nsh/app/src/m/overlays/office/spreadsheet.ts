/**
 * Bounded plain-text view of an .xlsx workbook: the grid the app's native reader
 * (calamine, `app/native/src/office`) fills. Hidden sheets are left out; an empty
 * visible sheet is kept. Merged slaves repeat the master text — the preview is a
 * plain grid, not HTML.
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
