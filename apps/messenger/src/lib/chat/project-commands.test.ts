import { expect, test } from "bun:test";
import { matchCommands, slashQuery, withCommand } from "./project-commands.svelte.ts";

const command = (name: string, aliases: string[] = []) => ({ name, description: "", argument_hint: "", aliases });

test("a command is the first word of the line after its slash, while the caret is in it", () => {
  expect(slashQuery("/", 1)).toBe("");
  expect(slashQuery("/Comp", 5)).toBe("comp");
  expect(slashQuery("/comp", 3)).toBe("comp");
  expect(slashQuery("/compact keep tests", 8)).toBe("compact");
  expect(slashQuery("/compact keep tests", 9)).toBeNull();
  expect(slashQuery("/compact", 0)).toBeNull();
  expect(slashQuery(" /compact", 3)).toBeNull();
  expect(slashQuery("看 /compact", 5)).toBeNull();
  expect(slashQuery("", 0)).toBeNull();
});

test("the best fits come first: a name or another name it goes by starting so, then the rest that have it", () => {
  const list = [command("clear", ["reset"]), command("compact"), command("frontend-design:frontend-design"), command("security-review"), command("review")];
  expect(matchCommands(list, "")).toEqual(list);
  expect(matchCommands(list, "re").map((c) => c.name)).toEqual(["clear", "review", "security-review"]);
  expect(matchCommands(list, "front").map((c) => c.name)).toEqual(["frontend-design:frontend-design"]);
  expect(matchCommands(list, "design").map((c) => c.name)).toEqual(["frontend-design:frontend-design"]);
  expect(matchCommands(list, "zzz")).toEqual([]);
});

test("a picked command takes the line's first word; what follows stays", () => {
  expect(withCommand("/co", "compact", false)).toEqual({ text: "/compact ", caret: 9 });
  expect(withCommand("/co", "compact", true)).toEqual({ text: "/compact", caret: 8 });
  expect(withCommand("/co keep the tests", "compact", false)).toEqual({ text: "/compact keep the tests", caret: 9 });
  expect(withCommand("/co keep the tests", "compact", true)).toEqual({ text: "/compact keep the tests", caret: 23 });
});
