import { expect, test } from "bun:test";
import { columnName, MAX_SPREADSHEET_COLUMNS } from "./spreadsheet.ts";

test("columnName is the zero-based Excel letter", () => {
  expect(columnName(0)).toBe("A");
  expect(columnName(25)).toBe("Z");
  expect(columnName(26)).toBe("AA");
  expect(columnName(MAX_SPREADSHEET_COLUMNS - 1)).toBe("CV");
  expect(() => columnName(-1)).toThrow(RangeError);
});
