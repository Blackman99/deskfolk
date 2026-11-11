//! Excel (xlsx, xls, ods) through `calamine`, as the messenger's `Spreadsheet`
//! (`office/spreadsheet.ts`): visible sheets only, at most 50 of them, 1000 rows that hold a value
//! and 100 columns each, every cell the string the messenger shows (a calendar day as `YYYY-MM-DD`,
//! a time of day as ISO 8601, a formula's saved result, or `=formula` when none was saved).

use std::io::Cursor;

use calamine::{Data, Reader, SheetVisible, open_workbook_auto_from_rs};
use serde::Serialize;

pub const MAX_SPREADSHEET_ROWS: usize = 1000;
pub const MAX_SPREADSHEET_COLUMNS: usize = 100;
pub const MAX_SPREADSHEET_SHEETS: usize = 50;

#[derive(Serialize, Debug, PartialEq)]
pub struct Row {
    /// 1-based worksheet row number.
    pub number: u32,
    pub cells: Vec<String>,
}

#[derive(Serialize, Debug, PartialEq)]
pub struct Sheet {
    pub name: String,
    pub rows: Vec<Row>,
    /// Columns kept, 1..n, capped at 100.
    pub columns: usize,
    /// A value row or column was left out of this sheet.
    pub truncated: bool,
}

#[derive(Serialize, Debug, PartialEq)]
pub struct Spreadsheet {
    pub kind: &'static str,
    pub sheets: Vec<Sheet>,
    /// A visible sheet past the first 50 was left out.
    #[serde(skip_serializing_if = "is_false")]
    pub truncated: bool,
}

fn is_false(b: &bool) -> bool {
    !*b
}

/// A number the way JavaScript's `String(n)` writes it.
pub fn js_number(n: f64) -> String {
    if !n.is_finite() {
        return String::new();
    }
    if n == 0.0 {
        return "0".into();
    }
    let abs = n.abs();
    if (1e-6..1e21).contains(&abs) {
        return format!("{n}");
    }
    let s = format!("{n:e}");
    match s.split_once('e') {
        Some((mantissa, exp)) if !exp.starts_with('-') => format!("{mantissa}e+{exp}"),
        _ => s,
    }
}

fn cell_text(value: &Data) -> String {
    match value {
        Data::Empty => String::new(),
        Data::String(s) | Data::DateTimeIso(s) | Data::DurationIso(s) => s.clone(),
        Data::Int(i) => i.to_string(),
        Data::Float(f) => js_number(*f),
        Data::Bool(b) => if *b { "true" } else { "false" }.into(),
        Data::Error(e) => e.to_string(),
        Data::DateTime(d) => match d.as_datetime() {
            Some(at) if at.time() == chrono::NaiveTime::MIN => at.format("%Y-%m-%d").to_string(),
            Some(at) => at.format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string(),
            None => js_number(d.as_f64()),
        },
    }
}

pub fn read(data: &[u8]) -> Result<Spreadsheet, String> {
    let mut book = open_workbook_auto_from_rs(Cursor::new(data)).map_err(|_| super::archive::INVALID.to_string())?;
    let visible: Vec<String> = book
        .sheets_metadata()
        .iter()
        .filter(|s| s.visible == SheetVisible::Visible)
        .map(|s| s.name.clone())
        .collect();
    let truncated = visible.len() > MAX_SPREADSHEET_SHEETS;
    let mut sheets = Vec::new();
    for name in visible.iter().take(MAX_SPREADSHEET_SHEETS) {
        let range = book.worksheet_range(name).unwrap_or_default();
        let formulas = book.worksheet_formula(name).unwrap_or_default();
        let (row0, col0) = range.start().map(|(r, c)| (r as usize, c as usize)).unwrap_or((0, 0));
        // Where a formula sits that has no saved result, it stands in for the value.
        let mut grid: Vec<(u32, Vec<(usize, String)>)> = Vec::new();
        let mut seen = std::collections::BTreeMap::<u32, Vec<(usize, String)>>::new();
        for (r, row) in range.rows().enumerate() {
            for (c, value) in row.iter().enumerate() {
                let text = cell_text(value);
                if text.is_empty() && !matches!(value, Data::String(_)) {
                    continue;
                }
                seen.entry((row0 + r + 1) as u32).or_default().push((col0 + c, text));
            }
        }
        if let Some((fr, fc)) = formulas.start().map(|(r, c)| (r as usize, c as usize)) {
            for (r, row) in formulas.rows().enumerate() {
                for (c, formula) in row.iter().enumerate() {
                    if formula.is_empty() {
                        continue;
                    }
                    let (n, col) = ((fr + r + 1) as u32, fc + c);
                    let cells = seen.entry(n).or_default();
                    match cells.iter_mut().find(|(at, _)| *at == col) {
                        Some((_, text)) if text.is_empty() => *text = format!("={formula}"),
                        Some(_) => {}
                        None => cells.push((col, format!("={formula}"))),
                    }
                }
            }
        }
        for (number, cells) in seen {
            if !cells.is_empty() {
                grid.push((number, cells));
            }
        }
        let count = grid.len();
        let mut sheet_truncated = count > MAX_SPREADSHEET_ROWS;
        grid.truncate(MAX_SPREADSHEET_ROWS);
        let width = grid.iter().flat_map(|(_, cells)| cells.iter().map(|(c, _)| c + 1)).max().unwrap_or(0);
        let columns = width.min(MAX_SPREADSHEET_COLUMNS);
        sheet_truncated |= width > MAX_SPREADSHEET_COLUMNS;
        let rows = grid
            .into_iter()
            .map(|(number, cells)| {
                let mut line = vec![String::new(); columns];
                for (c, text) in cells {
                    if c < columns {
                        line[c] = text;
                    }
                }
                Row { number, cells: line }
            })
            .collect();
        sheets.push(Sheet { name: name.clone(), rows, columns, truncated: sheet_truncated });
    }
    Ok(Spreadsheet { kind: "spreadsheet", sheets, truncated })
}

#[cfg(test)]
mod tests {
    use super::js_number;

    #[test]
    fn numbers_read_as_javascript_writes_them() {
        assert_eq!(js_number(5.0), "5");
        assert_eq!(js_number(-12.5), "-12.5");
        assert_eq!(js_number(0.1 + 0.2), "0.30000000000000004");
        assert_eq!(js_number(1e21), "1e+21");
        assert_eq!(js_number(1.5e-7), "1.5e-7");
        assert_eq!(js_number(123456789012345680000.0), "123456789012345680000");
    }
}
