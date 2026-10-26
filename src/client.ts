import { ROOTS } from "./generated/roots.ts";
import { buildRequest, field, fields, type OperationKind } from "./request.ts";
import { createTransport, type RequestOptions, type StashOptions } from "./transport.ts";
import type { Fields, Output, RootMethods, Selection } from "./types.ts";

/**
 * A client with one method per root field, plus `query`, `mutation` and `request`.
 * Every method takes an optional trailing `options` argument, e.g. to pass an `AbortSignal`.
 */
export interface StashClient extends RootMethods {
  /**
   * Sends several queries in one request. The keys become the result keys, so the same root
   * field can be selected twice with different arguments.
   */
  query<S extends Selection>(
    select: (query: Fields<"Query">) => S,
    options?: RequestOptions,
  ): Promise<Output<"Query", S>>;
  /** Sends several mutations in one request; Stash runs them in order. */
  mutation<S extends Selection>(
    select: (mutation: Fields<"Mutation">) => S,
    options?: RequestOptions,
  ): Promise<Output<"Mutation", S>>;
  /** Sends any GraphQL document as is and returns the untyped `data`. */
  request(
    query: string,
    variables?: Record<string, unknown>,
    options?: RequestOptions,
  ): Promise<Record<string, unknown>>;
}

export function createStash(options: StashOptions): StashClient {
  const transport = createTransport(options);
  // Async, so that errors in selection callbacks reject instead of throwing.
  const send = async (kind: OperationKind, select: () => unknown, call?: RequestOptions) => {
    const { request, upload } = buildRequest(kind, select());
    return transport.send(request, upload, call);
  };
  const operation =
    (kind: OperationKind) => (select: (fields: unknown) => unknown, call?: RequestOptions) =>
      send(kind, () => select(fields), call);

  const methods = Object.fromEntries(
    Object.entries(ROOTS).map(([name, [kind]]) => {
      const root = (args: unknown, select: unknown) => ({ [name]: field(name)(args, select) });
      const method =
        kind === "subscription"
          ? (...rest: unknown[]) => {
              const [args, select, call] = rootCall(rest);
              return transport.subscribe(
                buildRequest(kind, root(args, select)).request,
                name,
                call,
              );
            }
          : async (...rest: unknown[]) => {
              const [args, select, call] = rootCall(rest);
              return (await send(kind, () => root(args, select), call))[name];
            };
      return [name, method];
    }),
  );
  const client: object = {
    ...methods,
    query: operation("query"),
    mutation: operation("mutation"),
    request: transport.request,
  };
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- one method per entry in ROOTS
  return client as StashClient;
}

type RootCall = [args: unknown, select: unknown, options: RequestOptions | undefined];

/**
 * Reads a call to a root method, whose arguments and options the types can make optional. The
 * options come last, before them the selection, and before that the arguments.
 */
function rootCall(rest: unknown[]): RootCall {
  const options = callOptions(rest.at(-1));
  const call = options === undefined ? rest : rest.slice(0, -1);
  const at = call.findIndex((value) => typeof value === "function");
  return at === -1 ? [call[0], undefined, options] : [call[at - 1], call[at], options];
}

/**
 * The per-call options of a call, read from an untyped argument. Every field of `RequestOptions` has
 * to be recognised here, since a call cannot tell its arguments from its options otherwise.
 */
function callOptions(value: unknown): RequestOptions | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const signal = "signal" in value ? value.signal : undefined;
  const timeoutMs = "timeoutMs" in value ? value.timeoutMs : undefined;
  if (signal === undefined && timeoutMs === undefined) return undefined;
  if (signal !== undefined && !isAbortSignal(signal)) return undefined;
  if (timeoutMs !== undefined && typeof timeoutMs !== "number") return undefined;
  return { ...value, signal, timeoutMs };
}

/**
 * Whether `value` is an `AbortSignal`. `instanceof` rejects a signal created in another realm, such
 * as an iframe, which `fetch` accepts all the same.
 */
function isAbortSignal(value: unknown): value is AbortSignal {
  if (typeof value !== "object" || value === null) return false;
  return (
    "aborted" in value &&
    typeof value.aborted === "boolean" &&
    "addEventListener" in value &&
    typeof value.addEventListener === "function"
  );
}
