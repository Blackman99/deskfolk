/**
 * A model's name as the task map shows it beside a character: Claude's model ids read as the family
 * and version ("claude-opus-5-5" → "Opus 5.5", a dated id too); anything else is shown as it is,
 * since the map has no table of other vendors' names to shorten them by. The full id stays in the
 * tooltip.
 */
export function modelLabel(model: string | null | undefined): string {
  if (!model) return "";
  const claude = /^claude-(opus|sonnet|haiku)-(\d+)-(\d+)(?:-\d{8})?$/.exec(model);
  if (claude) return `${claude[1]![0]!.toUpperCase()}${claude[1]!.slice(1)} ${claude[2]}.${claude[3]}`;
  return model;
}

/** The family alone ("Opus"), for the short line on a building's plate. */
export function modelFamily(model: string | null | undefined): string {
  const label = modelLabel(model);
  return label.includes(" ") && /^claude-/.test(model ?? "") ? label.split(" ")[0]! : label;
}
