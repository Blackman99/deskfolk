/**
 * Mounts one screen on its own, for `Story.tsx`: the device's storage is read, the runtime starts
 * as the window's does (it connects through the same bridge), then the screen mounts.
 */
import { mount, type JSX } from "nsh";
import { loadStorage } from "./platform/globals";
import { keepAppWindow } from "./platform/viewport";

export function story(load: () => Promise<() => JSX.Element>): void {
  void loadStorage()
    .then(async () => {
      const [{ runtime }, view] = await Promise.all([import("./runtime"), load()]);
      runtime.start();
      return view;
    })
    .then((view) =>
      mount(() => {
        // As the app's root does (`Main.tsx`): the window's size is read from it on Windows and Linux.
        keepAppWindow();
        return view();
      }),
    );
}
