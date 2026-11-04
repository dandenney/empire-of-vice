// Type-level helper shared by snapshot and save tests.

/**
 * True only if T is plain data that survives JSON and structured clone unchanged:
 * no functions, bigint, symbols, undefined, Maps, Sets, or Dates.
 */
export type IsPlainData<T> = T extends string | number | boolean | null
  ? true
  : T extends bigint | symbol | undefined | ((...args: never[]) => unknown) | Date | Map<unknown, unknown> | Set<unknown>
    ? false
    : T extends readonly (infer E)[]
      ? IsPlainData<E>
      : T extends object
        ? false extends { [K in keyof T]-?: undefined extends T[K] ? false : IsPlainData<T[K]> }[keyof T]
          ? false
          : true
        : false;
