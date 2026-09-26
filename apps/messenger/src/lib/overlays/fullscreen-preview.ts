/** Full-window previews have no URL; Back and Escape close the newest one first. */
const previews: Array<() => void> = [];

export function holdFullscreenPreview(close: () => void): () => void {
  previews.push(close);
  return () => {
    const index = previews.lastIndexOf(close);
    if (index >= 0) previews.splice(index, 1);
  };
}

export function closeFullscreenPreview(): boolean {
  const close = previews.pop();
  if (!close) return false;
  close();
  return true;
}
