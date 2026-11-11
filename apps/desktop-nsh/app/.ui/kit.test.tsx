import { expect, test } from "nsh/test";
import { openStory } from "./fixture";

test("the kit renders and its buttons take presses", async () => {
  const app = await openStory("kit");
  await app.waitFor("id:primary", { timeout: 10_000 });
  expect(app.texts()).toContain("新建");
  await app.press("id:primary");
});
