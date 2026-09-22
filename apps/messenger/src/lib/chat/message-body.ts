import { handedOverPaths, withoutAttachmentDeclarations } from "../overlays/artifacts.ts";

/** Old messages may end with a generated inventory already represented by attachment entries. */
export function messageDisplayBody(body: string, attached: readonly string[]): string {
  const paths = new Set(handedOverPaths(body, attached));
  if (paths.size === 0) return body;
  const source = withoutAttachmentDeclarations(body);
  const lines = source.split("\n");
  let fence: { marker: string; length: number } | null = null;
  const inventory = lines.map((line) => {
    const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (marker) {
      const run = marker[1]!;
      if (!fence) fence = { marker: run[0]!, length: run.length };
      else if (run[0] === fence.marker && run.length >= fence.length && !marker[2]!.trim()) fence = null;
      return false;
    }
    if (fence) return false;
    const link = /^\[([^\]\n]+)\]\(([^\n]+)\)[ \t]*$/.exec(line);
    return Boolean(link && link[1] === link[2] && paths.has(link[2]!));
  });
  let end = lines.length;
  while (end > 0 && (!lines[end - 1]!.trim() || inventory[end - 1])) end--;
  return lines.slice(0, end).join("\n");
}
