/**
 * The language this computer's interface is in, as one of the app's two. A brand new database
 * starts its `locale` setting on it, so a first launch on an English Mac is in English rather than
 * in 中文 (the default for a database that never had one). macOS keeps it in `AppleLanguages`,
 * first entry first; `AppleLocale` is only the region's formats, which someone reading Chinese
 * abroad has in English. Other systems answer through `Intl`. Null when nothing can be read: the
 * setting then keeps its default.
 */
export function systemLanguage(): "zh" | "en" | null {
  if (process.platform !== "darwin") return languageOf(Intl.DateTimeFormat().resolvedOptions().locale);
  try {
    const result = Bun.spawnSync(["defaults", "read", "-g", "AppleLanguages"]);
    return result.success ? languageOf(firstListed(result.stdout.toString("utf8"))) : null;
  } catch {
    return null;
  }
}

/** The first entry of a list as `defaults read` prints it: `(\n    "zh-Hans-CN",\n    en\n)`. */
export function firstListed(printed: string): string | null {
  return /^\(\s*"?([^",\s)]+)/.exec(printed.trim())?.[1] ?? null;
}

/** `zh-Hans-CN`, `zh-TW` → zh; any other language → en, the app's other one. */
export function languageOf(tag: string | null | undefined): "zh" | "en" | null {
  const lower = tag?.trim().toLowerCase();
  if (!lower) return null;
  return lower.startsWith("zh") ? "zh" : "en";
}
