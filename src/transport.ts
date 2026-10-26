import type { GraphQLRequest } from "./request.ts";

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
  /** Cancels every request and subscription this client makes, as an `AbortSignal` does. */
  signal?: AbortSignal | undefined;
  /**
   * Deadline for every HTTP request, e.g. `30_000` for 30 seconds. A call can override it, and
   * subscriptions have none.
   */
  timeoutMs?: number | undefined;
  /** Custom fetch, e.g. to route through a proxy or for tests. */
  fetch?: ((input: string, init: RequestInit) => Promise<Response>) | undefined;
  /** Custom `graphql-ws` client for subscriptions; by default one is created on first use. */
  subscriptions?: SubscriptionClient | undefined;
}

/** Per-call options, passed as the last argument of every client method. */
export interface RequestOptions {
  /**
   * Cancels the request or subscription the way `fetch` does. `AbortSignal.timeout(ms)` gives it a
   * deadline; combine signals with `AbortSignal.any([...])`.
   */
  signal?: AbortSignal | undefined;
  /** Deadline for this request, replacing `timeoutMs` of the client. Subscriptions have none. */
  timeoutMs?: number | undefined;
}

/** Thrown for non-2xx responses and GraphQL errors. */
export class StashError extends Error {
  readonly status: number;
  readonly errors: readonly { message: string }[];
  /** The `data` of a partial result: GraphQL can return data next to errors. */
  readonly data: Record<string, unknown> | undefined;

  constructor(
    message: string,
    status: number,
    errors: { message: string }[] = [],
    data?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "StashError";
    this.status = status;
    this.errors = errors;
    this.data = data;
  }
}

/** Sends requests over HTTP and subscriptions over WebSocket; results are untyped here. */
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

  const send = async (request: GraphQLRequest, upload = false, call?: RequestOptions) => {
    const timeout = call?.timeoutMs ?? options.timeoutMs;
    const signal = combineSignals([
      options.signal,
      call?.signal,
      timeout === undefined ? undefined : AbortSignal.timeout(timeout),
    ]);
    const files: [path: string, file: Blob][] = [];
    // The copy is only used by the multipart branch, so skip it when there is nothing to upload.
    const withFiles = upload && hasFile(request.variables);
    const variables = withFiles ? extractFiles(request.variables, "variables", files) : undefined;
    const response = await (options.fetch ?? fetch)(options.endpoint, {
      method: "POST",
      // Never forward the API key to another host.
      redirect: "error",
      ...(signal === undefined ? {} : { signal }),
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
    send,
    /** Streams the values of root field `field`. */
    subscribe(
      request: GraphQLRequest,
      field: string,
      call?: RequestOptions,
    ): Subscription<unknown> {
      const signal = combineSignals([options.signal, call?.signal]);
      let source: Promise<AsyncIterableIterator<unknown>> | undefined;
      const open = () =>
        (source ??= subscriptions().then((subscriber) => subscriber.iterate(request)));
      // Nobody is left to handle a failing close once the consumer sees a finished subscription,
      // and an unhandled rejection here would take the process down.
      const stop = () => void subscription.return().catch(() => {});
      // Delegate instead of wrapping in an async generator: a generator only handles return()
      // at its next yield, so an idle subscription could never be stopped.
      const subscription: Subscription<unknown> = {
        async next() {
          if (signal?.aborted === true) return { value: undefined, done: true };
          const iterator = await open();
          const result = await iterator.next();
          if (result.done === true) return result;
          try {
            return { value: readData(result.value, 200, true)[field], done: false };
          } catch (error) {
            // A failing close must not replace the error the caller has to see.
            await iterator.return?.().catch(() => {});
            throw error;
          }
        },
        async return() {
          signal?.removeEventListener("abort", stop);
          const iterator = source === undefined ? undefined : await source;
          await iterator?.return?.();
          return { value: undefined, done: true };
        },
        [Symbol.asyncIterator]() {
          return this;
        },
      };
      // An abort has to reach an idle subscription too, so it cannot wait for the next value.
      if (signal?.aborted === true) stop();
      else signal?.addEventListener("abort", stop, { once: true });
      return subscription;
    },
    // Files may hide anywhere in a hand-written document, so always look for them.
    request: (query: string, variables: Record<string, unknown> = {}, call?: RequestOptions) =>
      send({ query, variables }, true, call),
  };
}

/**
 * Merges the signals of one call into the single one `fetch` takes. Missing signals are dropped,
 * and the common case of none or one allocates nothing. `AbortSignal.any` is why Node.js 20.3 is
 * the oldest supported release.
 */
function combineSignals(signals: (AbortSignal | undefined)[]): AbortSignal | undefined {
  const present = signals.filter((signal): signal is AbortSignal => signal !== undefined);
  const [first] = present;
  if (first === undefined) return undefined;
  return present.length === 1 ? first : AbortSignal.any(present);
}

/** A WebSocket constructor that accepts headers for the upgrade request, as Bun and Node do. */
type HeaderWebSocket = new (
  url: string | URL,
  init: { protocols?: string[] | undefined; headers: Record<string, string> },
) => WebSocket;

/** Loaded on first use, so HTTP-only users don't need the optional graphql-ws package. */
async function loadSubscriptions() {
  try {
    return await import("graphql-ws");
  } catch (error) {
    throw new Error(
      "Subscriptions need the optional `graphql-ws` package; install it with `npm install graphql-ws`",
      { cause: error },
    );
  }
}

async function createSubscriptionClient(
  endpoint: string,
  headers: Record<string, string>,
): Promise<SubscriptionClient> {
  const { createClient } = await loadSubscriptions();
  const url = endpoint.replace(/^http/, "ws");
  // Browsers, Bun and Node.js 22+ provide WebSocket; older Node.js needs a client of its own.
  const NativeWebSocket: HeaderWebSocket | undefined = globalThis.WebSocket;
  if (NativeWebSocket === undefined) {
    throw new Error(
      "Subscriptions need a global WebSocket (Node.js 22+, Bun or a browser); pass `subscriptions` to supply a graphql-ws client",
    );
  }
  // Browsers can't set headers on a WebSocket; they authenticate with the session cookie.
  if (Object.keys(headers).length === 0) return createClient({ url });
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
    const data = isObject(payload) && isObject(payload["data"]) ? payload["data"] : undefined;
    throw new StashError(message || `HTTP ${status}`, status, errors, data);
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

/** Whether variables contain a file, checked before copying them for a multipart request. */
function hasFile(value: unknown): boolean {
  if (value instanceof Blob) return true;
  if (Array.isArray(value)) return value.some(hasFile);
  if (isObject(value)) return Object.values(value).some(hasFile);
  return false;
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
