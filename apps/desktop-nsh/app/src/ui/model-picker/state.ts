/**
 * What `ModelPicker.svelte`'s script holds, as one controller the popover and the phone's sheet
 * (`ModelPicker.tsx`, `Sheet.tsx`) both read: the open state, the search, where the keys are, the
 * sheet's level. The picking logic itself is `src/m/model-picker.ts`'s.
 */
import { computed, effect, signal, windowSize } from "nsh";
import { copy } from "../../runtime";
import {
  findPicked,
  searchPicker,
  sourceCount,
  sourceRows,
  type PickerData,
  type PickerGroup,
  type PickerRow,
  type PickerSource,
} from "../../m/model-picker";

/** A source shows its groups as a level of their own on the phone once it lists this many. */
export const SHEET_GROUPS_AT = 30;
export const groupsLevel = (source: PickerSource) => source.groups.length > 1 && sourceCount(source) > SHEET_GROUPS_AT;

export type PickerOptions = {
  data: () => PickerData;
  value: () => string;
  placeholder: () => string;
  title: () => string | undefined;
  ariaLabel: () => string | undefined;
  /** Picks a row: the picker sets its value and reports a change. */
  pick: (row: PickerRow) => void;
};

export type Picker = ReturnType<typeof createPicker>;

export function createPicker(o: PickerOptions) {
  const open = signal(false);
  const query = signal("");
  /** The source whose models the popover shows on the right. */
  const activeKey = signal<string | null>(null);
  /** Where the arrow keys are in the popover: the sources on the left, or the rows. */
  const column = signal<"sources" | "rows">("rows");
  const cursor = signal(0);
  /** Where the sheet is: its list of sources (null), a source, a group of a source's models. */
  const sheetSource = signal<string | null>(null);
  const sheetGroup = signal<string | null>(null);

  const phone = () => windowSize().width <= 720;
  const picked = computed(() => findPicked(o.data(), o.value()));
  const specials = () => o.data().specials;
  const sources = () => o.data().sources;
  const many = () => o.data().sources.length > 1;
  const usable = () => o.data().sources.filter((source) => !source.disabled);
  const activeSource = computed(
    () => o.data().sources.find((source) => source.key === activeKey()) ?? usable()[0] ?? o.data().sources[0] ?? null,
  );
  const sheetAt = computed(() => o.data().sources.find((source) => source.key === sheetSource()) ?? null);
  const sheetGroupAt = computed(() => sheetAt()?.groups.find((group) => group.key === sheetGroup()) ?? null);
  /** Where a search looks: everything, or the source the sheet is in (a picker of one source: all of it, the rows above it too). */
  const scope = () => (phone() && many() ? sheetSource() : null);
  const trimmed = () => query().trim();
  const results = computed(() => (trimmed() ? searchPicker(o.data(), trimmed(), scope()) : []));
  /** The source a typed name would be for: the one in view, if it takes typed names. */
  const typingFor = (): PickerSource | null =>
    phone() ? (sheetAt() ?? (o.data().sources.length === 1 ? o.data().sources[0]! : null)) : many() ? activeSource() : (o.data().sources[0] ?? null);
  const typedRow = computed((): PickerRow | null => {
    const source = typingFor();
    const text = trimmed();
    if (!text || !source?.custom || source.disabled) return null;
    if (sourceRows(source).some((row) => row.value === text || row.label === text)) return null;
    const typed = source.custom(text);
    const t = copy();
    return typed === null ? null : { value: typed, label: t.modelPicker.useTyped(text), detail: t.modelPicker.usesTyped(source.label) };
  });
  /** The rows the arrow keys walk in the popover, in the order they are drawn. */
  const rows = computed((): PickerRow[] => {
    if (trimmed()) return [...results().flatMap((result) => result.rows), ...(typedRow() ? [typedRow()!] : [])];
    return [...o.data().specials, ...(activeSource() ? sourceRows(activeSource()!) : [])];
  });
  const display = () => (picked() ? picked()!.row.label : o.value() || o.placeholder());
  const displayHint = () => (many() && picked()?.source ? picked()!.source!.label : picked()?.row.hint);
  const sheetTitle = () => sheetGroupAt()?.label ?? sheetAt()?.label ?? o.title() ?? o.ariaLabel() ?? "";
  const sheetDepth = () => (sheetSource() !== null && many() ? 1 : 0) + (sheetGroup() !== null ? 1 : 0);

  function enabledFrom(start: number, step: 1 | -1): number {
    const list = rows();
    for (let at = start; at >= 0 && at < list.length; at += step) if (!list[at]!.disabled) return at;
    return -1;
  }

  function openPicker(): void {
    if (open()) return;
    query.set("");
    column.set("rows");
    const data = o.data();
    activeKey.set(picked()?.source?.key ?? usable()[0]?.key ?? data.sources[0]?.key ?? null);
    sheetGroup.set(null);
    sheetSource.set(many() ? null : (data.sources[0]?.key ?? null));
    const at = rows().findIndex((row) => row.value === o.value());
    cursor.set(at >= 0 ? at : Math.max(0, enabledFrom(0, 1)));
    open.set(true);
  }

  function close(): void {
    if (!open()) return;
    open.set(false);
    query.set("");
  }

  function activate(source: PickerSource): void {
    if (source.disabled) return;
    activeKey.set(source.key);
    cursor.set(enabledFrom(o.data().specials.length, 1));
  }

  function moveSource(step: 1 | -1): void {
    const list = o.data().sources;
    let at = list.findIndex((source) => source.key === activeSource()?.key);
    for (let i = 0; i < list.length; i++) {
      at = (at + step + list.length) % list.length;
      if (!list[at]!.disabled) {
        activate(list[at]!);
        return;
      }
    }
  }

  function arrow(key: "down" | "up" | "left" | "right"): void {
    if (!open() || phone()) return;
    if (key === "down" || key === "up") {
      const step = key === "down" ? 1 : -1;
      if (column() === "sources" && !trimmed()) return moveSource(step);
      const next = enabledFrom(cursor() + step, step);
      if (next >= 0) cursor.set(next);
    } else if (key === "left") {
      if (!trimmed() && many()) column.set("sources");
    } else if (!trimmed() && column() === "sources") {
      column.set("rows");
      cursor.set(Math.max(0, enabledFrom(o.data().specials.length, 1)));
    }
  }

  /** Enter in the search: into the rows from the sources, else the row the keys are on. */
  function enter(): void {
    if (phone()) return;
    if (column() === "sources" && !trimmed()) {
      column.set("rows");
      cursor.set(Math.max(0, enabledFrom(o.data().specials.length, 1)));
      return;
    }
    const row = rows()[cursor()];
    if (row) o.pick(row);
  }

  /** One level up; from the top (a picker of one source starts inside it), closed. */
  function sheetBack(): void {
    query.set("");
    if (sheetGroup() !== null) sheetGroup.set(null);
    else if (sheetSource() !== null && many()) sheetSource.set(null);
    else close();
  }

  /** Escape: the search first, then the picker (the phone's sheet: then up a level). */
  function escape(): void {
    if (query()) query.set("");
    else if (phone()) sheetBack();
    else close();
  }

  // A search moves the keys to the first row found; cleared, back to the model chosen.
  let searched = "";
  effect(() => {
    const now = trimmed();
    if (!open() || now === searched) return;
    searched = now;
    column.set("rows");
    const at = now ? -1 : rows().findIndex((row) => row.value === o.value());
    cursor.set(at >= 0 ? at : Math.max(0, enabledFrom(0, 1)));
  });

  return {
    open, query, activeKey, column, cursor, sheetSource, sheetGroup,
    phone, specials, sources, picked, many, activeSource, sheetAt, sheetGroupAt, trimmed, results, typingFor, typedRow, rows,
    display, displayHint, sheetTitle, sheetDepth,
    openPicker, close, activate, arrow, enter, sheetBack, escape,
    sheetInto(source: PickerSource): void {
      if (source.disabled) return;
      sheetSource.set(source.key);
      sheetGroup.set(null);
      query.set("");
    },
    sheetIntoGroup(group: PickerGroup): void {
      sheetGroup.set(group.key);
      query.set("");
    },
  };
}
