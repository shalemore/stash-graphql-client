import { buildRequest, type GraphQLRequest, type RawOperation } from "./request.ts";
import type { Operation, OperationResult, RequestField, SubscriptionField } from "./types.ts";

/** A running subscription; `return()`, or leaving a `for await` loop, unsubscribes. */
export interface Subscription<T> extends AsyncIterableIterator<T> {
  return(): Promise<IteratorResult<T, undefined>>;
}

/** Anything with the `iterate` method of a `graphql-ws` client. */
export interface SubscriptionClient {
  iterate(request: GraphQLRequest): AsyncIterableIterator<unknown>;
}

export interface StashOptions {
  /** GraphQL endpoint, e.g. `http://localhost:9999/graphql`. */
  endpoint: string;
  /** Sent as the `ApiKey` header. */
  apiKey?: string | undefined;
  /** Extra request headers. */
  headers?: Record<string, string> | undefined;
  /** Custom fetch, e.g. to add timeouts or for tests. */
  fetch?: ((input: string, init: RequestInit) => Promise<Response>) | undefined;
  /** Custom `graphql-ws` client for subscriptions; by default one is created on first use. */
  subscriptions?: SubscriptionClient | undefined;
}

/** Thrown for non-2xx responses and GraphQL errors. */
export class StashError extends Error {
  readonly status: number;
  readonly errors: readonly { message: string }[];

  constructor(message: string, status: number, errors: { message: string }[] = []) {
    super(message);
    this.name = "StashError";
    this.status = status;
    this.errors = errors;
  }
}

export interface StashRunner {
  /** Sends a query or mutation and returns the data of its root field. */
  run<K extends RequestField, S>(operation: Operation<K, S>): Promise<OperationResult<K, S>>;
  /** Sends several queries (or several mutations) in one request; keys become aliases. */
  batch<const B extends Record<string, Operation<RequestField>>>(
    operations: B,
  ): Promise<{
    [A in keyof B]: B[A] extends Operation<infer K, infer S> ? OperationResult<K, S> : never;
  }>;
  /** Streams a subscription; leaving the loop unsubscribes. */
  subscribe<K extends SubscriptionField, S>(
    operation: Operation<K, S>,
  ): Subscription<OperationResult<K, S>>;
  /** Sends any GraphQL document as is and returns the untyped `data`. */
  request(query: string, variables?: Record<string, unknown>): Promise<Record<string, unknown>>;
}

type HttpOperation = RawOperation & { upload?: boolean | undefined };

/** Untyped transport shared by `createRunner` and `createStash`. */
export function createTransport(options: StashOptions) {
  const headers = {
    ...(options.apiKey === undefined ? {} : { ApiKey: options.apiKey }),
    ...options.headers,
  };

  let client: Promise<SubscriptionClient> | undefined;
  const subscriptions = () =>
    (client ??=
      options.subscriptions === undefined
        ? createSubscriptionClient(options.endpoint, headers)
        : Promise.resolve(options.subscriptions));

  const send = async (request: GraphQLRequest, upload = false) => {
    const files: [path: string, file: Blob][] = [];
    const variables = upload ? extractFiles(request.variables, "variables", files) : undefined;
    const response = await (options.fetch ?? fetch)(options.endpoint, {
      method: "POST",
      // Never forward the API key to another host.
      redirect: "error",
      ...(files.length === 0
        ? {
            headers: { "content-type": "application/json", ...headers },
            body: JSON.stringify(request),
          }
        : { headers, body: multipart(request.query, variables, files) }),
    });
    const payload: unknown = await response.json().catch(() => undefined);
    return readData(payload, response.status, response.ok);
  };

  return {
    run: async (operation: HttpOperation) =>
      (await send(buildRequest([[undefined, operation]]), operation.upload))[operation.field],
    batch: (operations: Record<string, HttpOperation>) =>
      send(
        buildRequest(Object.entries(operations)),
        Object.values(operations).some((operation) => operation.upload === true),
      ),
    subscribe(operation: RawOperation): Subscription<unknown> {
      let source: Promise<AsyncIterableIterator<unknown>> | undefined;
      const open = () =>
        (source ??= subscriptions().then((subscriber) =>
          subscriber.iterate(buildRequest([[undefined, operation]])),
        ));
      // Delegate instead of wrapping in an async generator: a generator only handles return()
      // at its next yield, so an idle subscription could never be stopped.
      return {
        async next() {
          const iterator = await open();
          const result = await iterator.next();
          if (result.done === true) return result;
          try {
            return { value: readData(result.value, 200, true)[operation.field], done: false };
          } catch (error) {
            await iterator.return?.();
            throw error;
          }
        },
        async return() {
          const iterator = source === undefined ? undefined : await source;
          await iterator?.return?.();
          return { value: undefined, done: true };
        },
        [Symbol.asyncIterator]() {
          return this;
        },
      };
    },
    // Files may hide anywhere in a hand-written document, so always look for them.
    request: (query: string, variables: Record<string, unknown> = {}) =>
      send({ query, variables }, true),
  };
}

/** A client without per-field methods; pair it with `@shalemore/stash-api/operations`. */
export function createRunner(options: StashOptions): StashRunner {
  const runner: object = createTransport(options);
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- results are typed by the operations
  return runner as StashRunner;
}

/** A WebSocket constructor that accepts headers for the upgrade request, as Bun and Node do. */
type HeaderWebSocket = new (
  url: string | URL,
  init: { protocols?: string[] | undefined; headers: Record<string, string> },
) => WebSocket;

/** Loaded on first use, so code without subscriptions never bundles graphql-ws. */
async function createSubscriptionClient(
  endpoint: string,
  headers: Record<string, string>,
): Promise<SubscriptionClient> {
  const { createClient } = await import("graphql-ws");
  const url = endpoint.replace(/^http/, "ws");
  // Browsers can't set headers on a WebSocket; they authenticate with the session cookie.
  if (Object.keys(headers).length === 0) return createClient({ url });
  const NativeWebSocket: HeaderWebSocket = WebSocket;
  class AuthenticatedWebSocket extends NativeWebSocket {
    constructor(address: string | URL, protocols?: string | string[]) {
      super(address, {
        protocols: typeof protocols === "string" ? [protocols] : protocols,
        headers,
      });
    }
  }
  return createClient({ url, webSocketImpl: AuthenticatedWebSocket });
}

function readData(payload: unknown, status: number, ok: boolean) {
  const errors =
    isObject(payload) && Array.isArray(payload["errors"])
      ? payload["errors"].map((error: unknown) => ({
          message:
            isObject(error) && typeof error["message"] === "string"
              ? error["message"]
              : String(error),
        }))
      : [];
  if (!ok || errors.length > 0) {
    const message = errors.map((error) => error.message).join("\n");
    throw new StashError(message || `HTTP ${status}`, status, errors);
  }
  return isObject(payload) && isObject(payload["data"]) ? payload["data"] : {};
}

/** GraphQL multipart request, https://github.com/jaydenseric/graphql-multipart-request-spec */
function multipart(query: string, variables: unknown, files: [string, Blob][]) {
  const form = new FormData();
  form.append("operations", JSON.stringify({ query, variables }));
  form.append(
    "map",
    JSON.stringify(Object.fromEntries(files.map(([path], index) => [index, [path]]))),
  );
  for (const [index, [, file]] of files.entries()) form.append(String(index), file);
  return form;
}

/** Replaces files with null and records their paths, as the multipart spec requires. */
function extractFiles(value: unknown, path: string, files: [string, Blob][]): unknown {
  if (value instanceof Blob) {
    files.push([path, value]);
    return null;
  }
  if (Array.isArray(value)) {
    return value.map((item: unknown, index) => extractFiles(item, `${path}.${index}`, files));
  }
  if (isObject(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        extractFiles(item, `${path}.${key}`, files),
      ]),
    );
  }
  return value;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
