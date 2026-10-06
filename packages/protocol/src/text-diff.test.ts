import { describe, expect, test } from "bun:test";
import { changedLines, diffLines, merge3Lines } from "./text-diff.ts";

describe("diffLines / changedLines", () => {
  test("lists every line, kept, taken out or put in", () => {
    expect(diffLines("a\nb\nc", "a\nB\nc")).toEqual([
      { kind: "same", text: "a" },
      { kind: "del", text: "b" },
      { kind: "add", text: "B" },
      { kind: "same", text: "c" },
    ]);
  });

  test("changedLines keeps only the changes, with one gap per unchanged run between them", () => {
    expect(changedLines("a\nb\nc\nd\ne", "a\nB\nc\nd\nE")).toEqual([
      { kind: "del", text: "b" },
      { kind: "add", text: "B" },
      { kind: "gap", text: "" },
      { kind: "del", text: "e" },
      { kind: "add", text: "E" },
    ]);
    expect(changedLines("same", "same")).toEqual([]);
  });
});

describe("merge3Lines", () => {
  const base = ["Rule one.", "", "Rule two.", "", "Rule three."].join("\n");

  test("identical sides, or one side unchanged, take the other side whole", () => {
    expect(merge3Lines(base, base, base)).toEqual({ clean: true, text: base });
    const ours = base.replace("Rule two.", "Rule two, mine.");
    expect(merge3Lines(base, ours, base)).toEqual({ clean: true, text: ours });
    const theirs = base.replace("Rule three.", "Rule three, new.");
    expect(merge3Lines(base, base, theirs)).toEqual({ clean: true, text: theirs });
  });

  test("changes to different paragraphs both land", () => {
    const ours = base.replace("Rule one.", "Rule one, mine.");
    const theirs = base.replace("Rule three.", "Rule three, new.");
    expect(merge3Lines(base, ours, theirs)).toEqual({ clean: true, text: ["Rule one, mine.", "", "Rule two.", "", "Rule three, new."].join("\n") });
  });

  test("a paragraph the new default adds lands beside an edit elsewhere", () => {
    const ours = base.replace("Rule one.", "Rule one, mine.");
    const theirs = `${base}\n\nRule four.`;
    expect(merge3Lines(base, ours, theirs)).toEqual({ clean: true, text: `${ours}\n\nRule four.` });
  });

  test("the same change on both sides is no conflict", () => {
    const both = base.replace("Rule two.", "Rule 2.");
    expect(merge3Lines(base, both, both)).toEqual({ clean: true, text: both });
    const ours = base.replace("Rule two.", "Rule 2.").replace("Rule one.", "First.");
    expect(merge3Lines(base, ours, both)).toEqual({ clean: true, text: ours });
  });

  test("the same paragraph changed differently is a conflict", () => {
    const ours = base.replace("Rule two.", "Rule two, mine.");
    const theirs = base.replace("Rule two.", "Rule two, new.");
    expect(merge3Lines(base, ours, theirs)).toEqual({ clean: false, conflicts: 1 });
  });

  test("adjacent changes and delete-versus-edit are conflicts", () => {
    const lines = "a\nb\nc\nd";
    expect(merge3Lines(lines, "a\nB\nc\nd", "a\nb\nC\nd").clean).toBe(false);
    expect(merge3Lines(base, base.replace("\n\nRule two.", ""), base.replace("Rule two.", "Rule two, new.")).clean).toBe(false);
  });

  test("both sides appending different endings is a conflict", () => {
    expect(merge3Lines(base, `${base}\n\nMine.`, `${base}\n\nTheirs.`)).toEqual({ clean: false, conflicts: 1 });
  });

  test("an empty base merges only when one side is still empty", () => {
    expect(merge3Lines("", "", "new")).toEqual({ clean: true, text: "new" });
    expect(merge3Lines("", "mine", "theirs").clean).toBe(false);
  });

  test("a paragraph inserted right before one the other side rewrote is a conflict, not a guess", () => {
    // The new default inserts a paragraph before "Rule two."; ours rewrote "Rule two.".
    const theirs = base.replace("Rule two.", "Inserted.\n\nRule two.");
    const ours = base.replace("Rule two.", "Rule two, mine.");
    expect(merge3Lines(base, ours, theirs).clean).toBe(false);
  });
});
