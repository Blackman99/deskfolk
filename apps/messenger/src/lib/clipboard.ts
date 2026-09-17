export function copyText(text: string): void {
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.left = "-9999px";
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    document.execCommand("copy");
    document.body.removeChild(ta);
  } catch {
    // ignore
  }
  if (navigator.clipboard?.writeText) {
    void navigator.clipboard.writeText(text).catch(() => {});
  }
}
