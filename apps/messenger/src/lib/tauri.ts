export type TauriInternals = {
  invoke?: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;
  /** Registers a function and hands back the id the host calls it by. */
  transformCallback?: (callback: (payload: unknown) => void, once?: boolean) => number;
};

export function readTauriInternals(): TauriInternals | undefined {
  if (typeof globalThis === "undefined") return undefined;
  const w = globalThis as { __TAURI_INTERNALS__?: TauriInternals };
  return w.__TAURI_INTERNALS__;
}

export function isTauri(internals: TauriInternals | undefined = readTauriInternals()): boolean {
  return Boolean(internals?.invoke);
}

/**
 * Listen to something the window emits.
 *
 * Used for the menu: the native menu bar owns the accelerators, so a command picked there has to
 * be handed to the page rather than guessed at by it. Written against the internals directly
 * because this app does not carry the Tauri JavaScript package.
 *
 * Returns a function that stops listening. Outside the desktop window it does nothing at all.
 */
export function listenToWindow(
  event: string,
  handler: (payload: unknown) => void,
): () => void {
  const internals = readTauriInternals();
  if (!internals?.invoke || !internals.transformCallback) return () => {};
  const callbackId = internals.transformCallback((message) => {
    const wrapped = message as { payload?: unknown } | null;
    handler(wrapped && typeof wrapped === "object" && "payload" in wrapped ? wrapped.payload : message);
  });
  let eventId: number | null = null;
  let stopped = false;
  void internals
    .invoke("plugin:event|listen", { event, target: { kind: "Any" }, handler: callbackId })
    .then((id) => {
      eventId = typeof id === "number" ? id : null;
      // Asked to stop before the registration landed: undo it now that there is something to undo.
      if (stopped && eventId !== null) void internals.invoke?.("plugin:event|unlisten", { event, eventId });
    })
    .catch(() => {
      // A window whose permissions do not include events simply never hears any.
    });
  return () => {
    stopped = true;
    if (eventId !== null) void internals.invoke?.("plugin:event|unlisten", { event, eventId });
  };
}

/** Put the window away. What ⌘W does once there is no tab left to close. */
export async function hideDesktopWindow(): Promise<void> {
  const internals = readTauriInternals();
  if (!internals?.invoke) return;
  try {
    await internals.invoke("hide_main_window");
  } catch {
    // Nothing to do: the window stays where it is.
  }
}
