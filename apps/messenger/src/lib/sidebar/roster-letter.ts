/** First code point of a Bot name, as shown on the roster letter block. */
export function rosterLetter(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) return "?";
  return [...trimmed][0] ?? "?";
}
