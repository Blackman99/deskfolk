import type { ModelSource } from "./model-source.ts";

/**
 * What a model picker (`ModelPicker.svelte`) offers, in two levels: where models come from — each
 * endpoint, Claude Code, each other local agent (ADR 0079) — and the models each lists, grouped
 * when there are many (OpenCode's `provider/model` names by provider). Rows that are not models
 * ("follow the default") stand above them. Every picker builds this from the same helpers
 * (`model-picker-sources.ts`); only what a row's value means differs from picker to picker.
 */
export type PickerRow = {
  value: string;
  /** The model's own name where `value` is the picker's wrapping of it (JSON, `provider::model`): grouped and searched by it. */
  id?: string;
  /** The model's name as the picker shows it; within a group, without the group's prefix. */
  label: string;
  /** Under the name: the model's own id when its name differs, or what picking the row means. */
  detail?: string;
  /** Short words after the name: why it cannot be picked, or a note. */
  hint?: string;
  disabled?: boolean;
  /** A row above the sources that still names a model (a pin no list holds any more): where it comes from. */
  mark?: ModelSource | null;
};

export type PickerGroup = { key: string; label: string | null; rows: PickerRow[] };

export type PickerSource = {
  key: string;
  label: string;
  mark: ModelSource | null;
  /** Beside the name on the list of sources: "not signed in", or nothing (the count is drawn). */
  note?: string;
  disabled?: boolean;
  groups: PickerGroup[];
  /**
   * A name typed into the search, as this source would take it (a local agent's model "as it spells
   * it"): the row's value, or null when the name will not do. Absent: only listed models.
   */
  custom?: (typed: string) => string | null;
};

export type PickerData = { specials: PickerRow[]; sources: PickerSource[] };

export type PickedRow = { row: PickerRow; source: PickerSource | null; group: PickerGroup | null };

export function sourceRows(source: PickerSource): PickerRow[] {
  return source.groups.flatMap((group) => group.rows);
}

export function sourceCount(source: PickerSource): number {
  return source.groups.reduce((sum, group) => sum + group.rows.length, 0);
}

/** The row a value names, wherever it is: a special row, or a model under its source. */
export function findPicked(data: PickerData, value: string): PickedRow | null {
  const special = data.specials.find((row) => row.value === value);
  if (special) return { row: special, source: null, group: null };
  for (const source of data.sources) {
    for (const group of source.groups) {
      const row = group.rows.find((candidate) => candidate.value === value);
      if (row) return { row, source, group };
    }
  }
  return null;
}

/**
 * Models in groups, for a source that lists many: by the provider in front of a `provider/model`
 * name (OpenCode's), each row then named without it; otherwise, past `familyAt` models, by the
 * family a name starts with (`claude-…`, `gpt-…`). One group with no heading when neither gives at
 * least two groups worth having.
 */
export function groupModels(rows: readonly PickerRow[], options: { familyAt?: number; groupLabel?: (key: string) => string } = {}): PickerGroup[] {
  const labelOf = options.groupLabel ?? ((key: string) => key);
  const whole = (): PickerGroup[] => [{ key: "", label: null, rows: [...rows] }];
  if (rows.length === 0) return [];
  const slashed = rows.filter((row) => (row.id ?? row.value).includes("/") || row.label.includes("/"));
  if (slashed.length >= Math.max(2, Math.ceil(rows.length / 2))) {
    const groups = new Map<string, PickerRow[]>();
    for (const row of rows) {
      const name = row.label.includes("/") ? row.label : (row.id ?? row.value);
      const cut = name.indexOf("/");
      const key = cut > 0 ? name.slice(0, cut) : "";
      const short = cut > 0 && row.label === name ? name.slice(cut + 1) : row.label;
      const list = groups.get(key) ?? [];
      list.push(short === row.label ? row : { ...row, label: short, detail: row.detail ?? row.id ?? row.value });
      groups.set(key, list);
    }
    if (groups.size < 2) return whole();
    return [...groups].map(([key, list]) => ({ key, label: key ? labelOf(key) : null, rows: list }));
  }
  const familyAt = options.familyAt ?? 40;
  if (rows.length < familyAt) return whole();
  const groups = new Map<string, PickerRow[]>();
  for (const row of rows) {
    const key = ((row.id ?? row.value).match(/^[a-z]+/i)?.[0] ?? "").toLowerCase();
    const list = groups.get(key) ?? [];
    list.push(row);
    groups.set(key, list);
  }
  const worth = [...groups.values()].filter((list) => list.length >= 2).length;
  if (groups.size < 3 || worth < 2) return whole();
  return [...groups].map(([key, list]) => ({ key, label: key ? labelOf(key) : null, rows: list }));
}

export type PickerResult = { source: PickerSource | null; rows: PickerRow[] };

/**
 * What a search finds: every row whose name, id, detail, group or source holds each word typed, in
 * the order of the sources, the closest names first within each. Specials are searched too.
 */
export function searchPicker(data: PickerData, query: string, within: string | null = null): PickerResult[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];
  const score = (row: PickerRow, haystack: string): number | null => {
    if (!words.every((word) => haystack.includes(word))) return null;
    const label = row.label.toLowerCase();
    const first = words[0]!;
    if (label === first) return 0;
    if (label.startsWith(first)) return 1;
    if (new RegExp(`(^|[\\s/._:-])${first.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`).test(label)) return 2;
    return 3;
  };
  const results: PickerResult[] = [];
  if (!within) {
    const specials = data.specials
      .map((row) => ({ row, at: score(row, `${row.label} ${row.detail ?? ""}`.toLowerCase()) }))
      .filter((hit) => hit.at !== null);
    if (specials.length > 0) results.push({ source: null, rows: specials.map((hit) => hit.row) });
  }
  for (const source of data.sources) {
    if (within && source.key !== within) continue;
    const hits: Array<{ row: PickerRow; at: number; order: number }> = [];
    let order = 0;
    for (const group of source.groups) {
      for (const row of group.rows) {
        const at = score(row, `${row.label} ${row.id ?? row.value} ${row.detail ?? ""} ${group.label ?? ""} ${source.label}`.toLowerCase());
        if (at !== null) hits.push({ row, at, order: order++ });
        else order++;
      }
    }
    if (hits.length === 0) continue;
    hits.sort((a, b) => a.at - b.at || a.order - b.order);
    results.push({ source, rows: hits.map((hit) => hit.row) });
  }
  return results;
}
