/**
 * `Intl.RelativeTimeFormat` for the desktop engine, which has `DateTimeFormat` and `NumberFormat`
 * but not this one. Only what the messenger formats (`settings/device-last-active.ts`): Chinese
 * and English, long style, `numeric: "auto"` or `"always"`, seconds to years. The web has the
 * browser's own, and this is installed only where there is none.
 */
type Unit = "second" | "minute" | "hour" | "day" | "week" | "month" | "year";

const ZH: Record<Unit, string> = { second: "秒", minute: "分钟", hour: "小时", day: "天", week: "周", month: "个月", year: "年" };
const ZH_AUTO: Partial<Record<Unit, Record<number, string>>> = {
  second: { 0: "现在" },
  minute: { 0: "此刻" },
  hour: { 0: "这一时间" },
  day: { [-2]: "前天", [-1]: "昨天", 0: "今天", 1: "明天", 2: "后天" },
  week: { [-1]: "上周", 0: "本周", 1: "下周" },
  month: { [-1]: "上个月", 0: "本月", 1: "下个月" },
  year: { [-1]: "去年", 0: "今年", 1: "明年" },
};
const EN_AUTO: Partial<Record<Unit, Record<number, string>>> = {
  second: { 0: "now" },
  minute: { 0: "this minute" },
  hour: { 0: "this hour" },
  day: { [-1]: "yesterday", 0: "today", 1: "tomorrow" },
  week: { [-1]: "last week", 0: "this week", 1: "next week" },
  month: { [-1]: "last month", 0: "this month", 1: "next month" },
  year: { [-1]: "last year", 0: "this year", 1: "next year" },
};

function unitOf(raw: string): Unit {
  const unit = raw.replace(/s$/, "") as Unit;
  if (!(unit in ZH)) throw new RangeError(`Invalid unit argument for format() '${raw}'`);
  return unit;
}

export class RelativeTimeFormat {
  readonly #zh: boolean;
  readonly #auto: boolean;
  constructor(locales?: string | string[], options?: { numeric?: "always" | "auto"; style?: string }) {
    const tag = (Array.isArray(locales) ? locales[0] : locales) ?? "en";
    this.#zh = /^zh/i.test(tag);
    this.#auto = options?.numeric === "auto";
  }

  format(value: number, rawUnit: string): string {
    const unit = unitOf(rawUnit);
    const n = Object.is(value, -0) ? 0 : value;
    if (this.#auto) {
      const word = (this.#zh ? ZH_AUTO : EN_AUTO)[unit]?.[n];
      if (word) return word;
    }
    const amount = Math.abs(n);
    if (this.#zh) return n < 0 ? `${amount}${ZH[unit]}前` : `${amount}${ZH[unit]}后`;
    const noun = amount === 1 ? unit : `${unit}s`;
    return n < 0 ? `${amount} ${noun} ago` : `in ${amount} ${noun}`;
  }

  resolvedOptions(): { locale: string; numeric: string; style: string } {
    return { locale: this.#zh ? "zh-CN" : "en", numeric: this.#auto ? "auto" : "always", style: "long" };
  }
}
