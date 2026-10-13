import type { CallInput, Operation, RootField, RootSelection } from "./types.ts";

/** Creates a typed builder for one root field. */
export function define<K extends RootField>(
  field: K,
  kind: Operation["kind"],
  types: Operation["types"],
  upload?: true,
) {
  return <const S extends RootSelection<K>>(...input: CallInput<K, S>): Operation<K, S> => {
    const [args, select]: readonly [args?: object | undefined, select?: unknown] = input;
    return upload
      ? { field, kind, types, args, select, upload }
      : { field, kind, types, args, select };
  };
}
