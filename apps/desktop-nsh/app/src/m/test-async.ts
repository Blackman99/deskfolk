/** Lets one timer turn pass, so pending promises and fake-runtime replies land and the effects they set off run. */
export async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

/** One timer turn; for tests of plain modules. */
export function settleTimers(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/** A promise a test settles by hand, to hold a request in flight while it checks what the UI shows. */
export function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}
