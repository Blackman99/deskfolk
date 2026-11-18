/**
 * What the logic specs (the `*.spec.ts` files under `app/src/m`) run in: `bun test` with happy-dom for the
 * browser the phone's page runs in. The specs cover what runs on that page or needs no engine at
 * all; what drives the NSH stores runs under `nsh test` (`*.test.ts`), in the app's own engine.
 *
 *   bun test --conditions browser --preload ./scripts/spec-setup.ts .spec.ts
 */
import { GlobalRegistrator } from "@happy-dom/global-registrator";

if (!(globalThis as { document?: unknown }).document) {
  GlobalRegistrator.register();
}

// happy-dom takes navigator.platform from the host OS. The suite is written against the Mac window
// (⌘ labels, Ctrl-click as a right-click, Finder wording), and the Windows branches are tested by
// passing the platform in; pinned, a Windows CI host runs the same suite as a Mac.
Object.defineProperty(navigator, "platform", { configurable: true, value: "MacIntel" });
