/** Up to three names in quotes, then how many there are in all (`unit`: 项, 个). */
export const zhNames = (names: string[], unit: string) =>
  `${names.slice(0, 3).map((name) => `“${name}”`).join("、")}${names.length > 3 ? ` 等 ${names.length} ${unit}` : ""}`;

/** Up to three names in quotes, then how many more. */
export const enNames = (names: string[]) =>
  `${names.slice(0, 3).map((name) => `“${name}”`).join(", ")}${names.length > 3 ? ` and ${names.length - 3} more` : ""}`;
