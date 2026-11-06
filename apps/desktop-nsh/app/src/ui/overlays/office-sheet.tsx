/**
 * The workbook half of `OfficeViewer.svelte`: the sheet tabs (`.office-sheets`), the notice when
 * something was left out, and the grid (`.office-grid`): a `DataTable` whose first column is the
 * worksheet's own row number (it has gaps where empty rows were skipped, so it is a column and
 * not the table's row header) and whose titles are the column letters.
 */
import { computed, Scroll, Text, View } from "nsh";
import { DataTable, type DataTableColumn } from "nsh/base";
import { copy } from "../../runtime";
import { columnName } from "../../m/overlays/office/spreadsheet.ts";
import type { Spreadsheet } from "./office-model";

const ROW_COLUMN = "row";

export function SheetView(props: { book: Spreadsheet; index: number; onIndex: (index: number) => void }) {
  const labels = () => copy().stream.office;
  const sheet = computed(() => props.book.sheets[props.index]);
  const columns = computed<DataTableColumn[]>(() => {
    const current = sheet();
    if (!current) return [];
    return [
      { key: ROW_COLUMN, title: labels().row, width: 56, fixed: true, selectable: false, align: "center", resizable: false, movable: false },
      ...Array.from({ length: current.columns }, (_, i) => ({ key: `c${i}`, title: columnName(i), width: 120, movable: false })),
    ];
  });
  const rows = computed(() => {
    const current = sheet();
    if (!current) return [];
    return current.rows.map((row) => {
      const out: Record<string, string | number> = { [ROW_COLUMN]: row.number };
      row.cells.forEach((cell, i) => (out[`c${i}`] = cell));
      return out;
    });
  });
  return (
    <If when={props.book.sheets.length > 0} else={<Text class="px-4 py-6 text-[13px] text-ink-muted">{labels().empty}</Text>}>
      <View class="flex-1 min-h-0">
        <Scroll horizontal class="flex-none border-b border-line" contentClass="flex-row gap-1 p-2" testID="office-sheets">
          {props.book.sheets.map((tab, index) => (
            <View
              role="button"
              testID={`office-sheet-${index}`}
              accessibilityLabel={tab.name}
              accessibilityState={{ selected: props.index === index }}
              onPress={() => props.onIndex(index)}
              class={`shrink-0 max-w-[220px] px-[10px] py-[6px] rounded-[5px] border ${props.index === index ? "border-brand bg-accent-tint" : "border-line bg-pane hover:bg-row-hover"}`}
            >
              <Text class={`text-[12px] line-clamp-1 ${props.index === index ? "text-brand" : "text-ink"}`}>{tab.name}</Text>
            </View>
          ))}
        </Scroll>
        <If when={props.book.truncated || sheet()?.truncated}>
          <Text testID="office-truncated" class="px-[10px] py-[7px] text-[11px] text-ink-muted border-b border-line-subtle">
            {labels().truncated}
          </Text>
        </If>
        <If
          when={(sheet()?.rows.length ?? 0) > 0 && (sheet()?.columns ?? 0) > 0}
          else={<Text testID="office-empty-sheet" class="px-4 py-6 text-[13px] text-ink-muted">{labels().emptySheet}</Text>}
        >
          <DataTable
            testID="office-grid"
            accessibilityLabel={sheet()?.name}
            class="flex-1 min-h-0"
            columns={columns()}
            data={rows()}
            rowHeight={28}
            fontSize={12}
            rowSelectable={false}
            columnSelectable={false}
            cellSelectable
            rowHeader={false}
            resizableColumns
          />
        </If>
      </View>
    </If>
  );
}
