export function formatDeviceLastActive(lastActiveUnix: number, nowMs: number, locale: "zh" | "en"): string {
  const deltaSeconds = Math.min(0, Math.round(lastActiveUnix - nowMs / 1000));
  const age = Math.abs(deltaSeconds);
  const formatter = new Intl.RelativeTimeFormat(locale === "zh" ? "zh-CN" : "en", { numeric: "auto" });

  if (age < 45) return formatter.format(0, "second");
  if (age < 90) return formatter.format(-1, "minute");
  if (age < 45 * 60) return formatter.format(Math.round(deltaSeconds / 60), "minute");
  if (age < 90 * 60) return formatter.format(-1, "hour");
  if (age < 22 * 60 * 60) return formatter.format(Math.round(deltaSeconds / 3600), "hour");
  if (age < 36 * 60 * 60) return formatter.format(-1, "day");
  if (age < 26 * 24 * 60 * 60) return formatter.format(Math.round(deltaSeconds / 86400), "day");
  if (age < 45 * 24 * 60 * 60) return formatter.format(-1, "month");
  if (age < 320 * 24 * 60 * 60) return formatter.format(Math.round(deltaSeconds / 2592000), "month");
  if (age < 548 * 24 * 60 * 60) return formatter.format(-1, "year");
  return formatter.format(Math.round(deltaSeconds / 31536000), "year");
}
