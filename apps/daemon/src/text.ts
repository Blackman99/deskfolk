export function codePointCount(text: string): number {
  return [...text].length;
}

export function takeCodePoints(text: string, limit: number): {
  text: string;
  original: number;
  truncated: boolean;
} {
  const points = [...text];
  if (points.length <= limit) {
    return { text, original: points.length, truncated: false };
  }
  return {
    text: points.slice(0, limit).join(""),
    original: points.length,
    truncated: true,
  };
}

export function compactJson(value: unknown): string {
  return JSON.stringify(value);
}
