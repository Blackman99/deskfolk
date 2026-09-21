# ADR 0023: Opt-in independent runtime, default window supervision

Status: experimental implementation; production activation blocked. Date: 2026-09-20.

## Decision

Default supervision remains [ADR 0008](0008-window-supervises-daemon.md): the window process owns Spawn and Quit. An Aqua user-domain LaunchAgent is an **opt-in** for leaving the desktop without stopping the runtime. The product switch exists in settings, but production stays **fail-closed** until a sealed native runtime (G-pack) and an isolated-host G-launchd check pass. There is no environment fake that installs a real job on a developer machine.

The job, when a future qualified build may enable it:

- Absolute Program and plist paths; `lstat` rejects program/plist symlinks; user-owned and not group/world writable for program, ancestors, plist, plist parent, latch, and marker. Latch writes are `0600`.
- `RunAtLoad`, `ThrottleInterval` 10, `KeepAlive.PathState[runtime.stop]=false`. **No PathExists.** The daemon stays in the foreground; it does not fork+exit.
- Enable: shared quiesce (never exit) → window `supervising=false` → no-latch exit → wait until `Probe::Down` (bounded pause) → `launchctl bootstrap` of a **new** child. Do not adopt the previous PID. A leftover `runtime.independent` is ignored unless policy is available **and** this window bootstrapped or `launchctl` shows `com.real-bot.runtime` loaded. Bootstrap failure stays Down; do not silently restore window Spawn unless the user cancels. Gated disable/recovery still deletes a stale marker and restores window Spawn.
- Disable with a window: `supervising=true` first → bootout without writing the latch → remove marker and plist → window Spawn. Disable without a window: warn, latch+stop+bootout, then remove marker and plist; no orphans.
- Explicit stop writes the latch then exits. A crash without a latch may restart. Cmd+Q while independent (when actually enabled) closes UI only; default window-supervised quit still stops both.
- `launch_at_login` remains window autolaunch and is independent of the runtime agent. `pnpm dev` never installs the agent.

Shared drain, stop-latch files and `SupervisorControl` come from ticket 07. This ticket owns exit and launchd handoff; ticket 11 owns maintenance restart after drain.

## Consequences and remaining gates

Handoff and plist rendering are unit-tested with a fake `launchctl`. Mutating IPC is bundled-frame / local-only. Production commands refuse enablement with `g_pack_not_verified` / `dev_does_not_install_agent`. G-pack and G-launchd are **not passed**. Do not treat this ADR as permission to install a personal LaunchAgent.
