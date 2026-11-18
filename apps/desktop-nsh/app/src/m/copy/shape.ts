/** The type a locale's copy must have: the same keys as `zh`, every string widened, functions kept. */
export type CopyShape<T> = T extends (...args: infer A) => string
  ? (...args: A) => string
  : T extends object
    ? { [K in keyof T]: CopyShape<T[K]> }
    : string;
