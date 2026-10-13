import { ROOTS } from "./generated/roots.ts";
import { buildRequest, field, fields, type OperationKind } from "./request.ts";
import { createTransport, type StashOptions } from "./transport.ts";
import type { Fields, Output, RootMethods, Selection } from "./types.ts";

/** A client with one method per root field, plus `query`, `mutation` and `request`. */
export interface StashClient extends RootMethods {
  /**
   * Sends several queries in one request. The keys become the result keys, so the same root
   * field can be selected twice with different arguments.
   */
  query<S extends Selection>(select: (query: Fields<"Query">) => S): Promise<Output<"Query", S>>;
  /** Sends several mutations in one request; Stash runs them in order. */
  mutation<S extends Selection>(
    select: (mutation: Fields<"Mutation">) => S,
  ): Promise<Output<"Mutation", S>>;
  /** Sends any GraphQL document as is and returns the untyped `data`. */
  request(query: string, variables?: Record<string, unknown>): Promise<Record<string, unknown>>;
}

export function createStash(options: StashOptions): StashClient {
  const transport = createTransport(options);
  // Async, so that errors in selection callbacks reject instead of throwing.
  const send = async (kind: OperationKind, select: () => unknown) => {
    const { request, upload } = buildRequest(kind, select());
    return transport.send(request, upload);
  };
  const operation = (kind: OperationKind) => (select: (fields: unknown) => unknown) =>
    send(kind, () => select(fields));

  const methods = Object.fromEntries(
    Object.entries(ROOTS).map(([name, [kind]]) => {
      const root = (args: unknown, select: unknown) => ({ [name]: field(name)(args, select) });
      return [
        name,
        kind === "subscription"
          ? (args?: unknown, select?: unknown) =>
              transport.subscribe(buildRequest(kind, root(args, select)).request, name)
          : async (args?: unknown, select?: unknown) =>
              (await send(kind, () => root(args, select)))[name],
      ];
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
