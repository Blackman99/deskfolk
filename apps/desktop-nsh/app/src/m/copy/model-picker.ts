import type { CopyShape } from "./shape.ts";

/** The model picker (`ModelPicker.svelte`): where models come from, then the models, with a search. */
export const zh = {
  search: "搜索模型",
  searchIn: (source: string) => `在 ${source} 里搜索`,
  sources: "来源",
  count: (n: number) => `${n} 个`,
  noMatch: "没有匹配的模型",
  noModels: "它没列出模型",
  typeOwn: "在上面输入它认的模型名",
  typeShort: "自己填",
  useTyped: (typed: string) => `用「${typed}」`,
  usesTyped: (source: string) => `按 ${source} 的写法`,
  back: "返回",
  close: "关闭",
};

export const en: CopyShape<typeof zh> = {
  search: "Search models",
  searchIn: (source: string) => `Search ${source}`,
  sources: "Sources",
  count: (n: number) => `${n}`,
  noMatch: "No model matches",
  noModels: "It lists no models",
  typeOwn: "Type a model name it knows, above",
  typeShort: "type one",
  useTyped: (typed: string) => `Use "${typed}"`,
  usesTyped: (source: string) => `As ${source} spells it`,
  back: "Back",
  close: "Close",
};
