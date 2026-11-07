/**
 * The phone's build (`Hosted.tsx`, packaged with `nsh package Hosted.tsx --target web` and served
 * from the relay's origin): the messenger's hosted switch, `REAL_BOT_HOSTED=1`, which Vite compiles
 * in as `__REAL_BOT_HOSTED__`. Set here, before any `src/m` module is evaluated, so the messenger's
 * `remote/mode.ts` reads `HOSTED_MESSENGER` as true and the runtime pairs through the relay and
 * talks to the Mac over the encrypted channel (`RemoteApi`) instead of finding a local endpoint.
 *
 * Imported for its effect, first, by `Hosted.tsx` only: the desktop and the local web build enter
 * through `App.tsx` and never set it. ADR 0107, Phase 1c.
 */
(globalThis as { __REAL_BOT_HOSTED__?: boolean }).__REAL_BOT_HOSTED__ = true;
