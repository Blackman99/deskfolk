/** The BCP 47 tag for the UI locale: Chinese is always `zh-CN`; English is `en-US` unless a site wants plain `en`. */
export function localeTag(locale: "zh" | "en", en: "en-US" | "en" = "en-US"): string {
  return locale === "zh" ? "zh-CN" : en;
}
