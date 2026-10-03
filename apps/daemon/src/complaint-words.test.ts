import { expect, test } from "bun:test";
import { clauseObjects, clausesOf } from "./complaint-words";

const objects = (line: string) => clausesOf(line).some(clauseObjects);

test("a clause objects when it complains about the work as it stands", () => {
  for (const line of ["C07 好像有问题", "画面好假", "C07 好短啊", "母带太短了，不对", "前三镜背景严重跳跃，1 镜在仓外", "C07 跳跃，C08 很好", "这个镜头不好", "分镜不对，第 2 镜反了"]) {
    expect({ line, objects: objects(line) }).toEqual({ line, objects: true });
  }
});

test("praise, a declined redo, a question, a condition, another time or version, or something settled does not object", () => {
  for (const line of ["C07 是不是太短了？", "如果太短就告诉我", "上次失败的那版删了吧", "下集别再这么长了", "C08 太长的问题已经解决了", "有问题随时找我",
    "Nothing is wrong", "很好，就这样", "别重做了，就这样", "C07 很好，比上一版那个错乱的好多了", "收到", "辛苦了"]) {
    expect({ line, objects: objects(line) }).toEqual({ line, objects: false });
  }
});

test("only the clause that complains names its part", () => {
  expect(clausesOf("C07 跳跃，C08 很好").map((clause) => [clause, clauseObjects(clause)])).toEqual([["C07 跳跃", true], ["C08 很好", false]]);
});

test("starting over objects to the work as it stands; a start-over turned down does not", () => {
  // 2026-10-03, the video group: said about the whole job, it never read as a complaint.
  for (const line of ["从头再做一遍，之前的作废", "之前的都作废", "推倒重来", "重新做一版", "整个重新拍"]) {
    expect({ line, objects: objects(line) }).toEqual({ line, objects: true });
  }
  for (const line of ["不用从头再做", "不必重新做，改两处就行", "别推翻，就这样"]) {
    expect({ line, objects: objects(line) }).toEqual({ line, objects: false });
  }
});
