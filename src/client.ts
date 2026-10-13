import { ROOTS } from "./generated/roots.ts";
import {
  createTransport,
  type StashOptions,
  type StashRunner,
  type Subscription,
} from "./runner.ts";
import type {
  ArgsInput,
  CallInput,
  Root,
  Operation,
  OperationResult,
  RootField,
  RootSelection,
  ScalarField,
  SubscriptionField,
} from "./types.ts";

type RootMethods = {
  [K in keyof Root]: <const S extends RootSelection<K>>(
    ...input: CallInput<K, S>
  ) => K extends SubscriptionField
    ? Subscription<OperationResult<K, S>>
    : Promise<OperationResult<K, S>>;
};

/** A client with one method per root field, plus `run`, `batch`, `subscribe` and `request`. */
export interface StashClient extends RootMethods, StashRunner {}

/**
 * Describes a root field call without sending it, for `stash.batch` or `stash.run`.
 * The selection is its own parameter so that its type can be inferred.
 */
export function operation<K extends ScalarField>(
  field: K,
  args: ArgsInput<K>,
): Operation<K, undefined>;
export function operation<K extends RootField, const S extends RootSelection<K>>(
  field: K,
  args: ArgsInput<K>,
  select: S,
): Operation<K, S>;
export function operation(field: RootField, args: object | undefined, select?: unknown) {
  const root = ROOTS[field];
  if (root === undefined) throw new Error(`Unknown root field: ${field}`);
  const [kind, types, upload] = root;
  return { field, kind, types, args, select, ...(upload ? { upload } : {}) };
}

export function createStash(options: StashOptions): StashClient {
  const transport = createTransport(options);
  const methods = Object.fromEntries(
    Object.entries(ROOTS).map(([field, [kind, types, upload]]) => [
      field,
      (args?: object, select?: unknown) => {
        const call = { field, kind, types, args, select, upload };
        return kind === "subscription" ? transport.subscribe(call) : transport.run(call);
      },
    ]),
  );
  const client: object = { ...methods, ...transport };
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- one method per entry in ROOTS
  return client as StashClient;
}
