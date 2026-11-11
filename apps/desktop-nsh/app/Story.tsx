/**
 * One screen on its own (`host.params.story`, a name in `stories/index.ts`), for its tests and for
 * looking at it in a shell (`deskfolk-nsh --story <name>`) before the window routes to it. An entry
 * of the app's own directory, so the app's theme and capabilities apply.
 */
import "./src/platform/install";
import { host } from "nsh";
import { story } from "./src/story";
import { stories } from "./stories";

const name = String((host.params as { story?: string }).story ?? "kit");
story(async () => {
  const load = stories[name];
  if (!load) throw new Error(`no story ${name}: add it to stories/index.ts`);
  const view = (await load()).default;
  return view;
});
