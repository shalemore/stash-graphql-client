import { expect, test } from "bun:test";

import { createClient } from "graphql-ws";

import { createStash } from "./client.ts";
import type { GraphQLRequest } from "./request.ts";
import { StashError, type SubscriptionClient } from "./transport.ts";

test("a graphql-ws client can be passed as is", () => {
  const client: SubscriptionClient = createClient({ url: "ws://stash.test/graphql", lazy: true });
  expect(typeof client.iterate).toBe("function");
});

test("streams subscription results and stops when the loop ends", async () => {
  const requests: GraphQLRequest[] = [];
  let unsubscribed = false;
  const subscriptions: SubscriptionClient = {
    async *iterate(request) {
      requests.push(request);
      try {
        yield { data: { jobsSubscribe: { type: "ADD", job: { id: "1" } } } };
        yield { data: { jobsSubscribe: { type: "REMOVE", job: { id: "1" } } } };
      } finally {
        unsubscribed = true;
      }
    },
  };
  const stash = createStash({ endpoint: "http://stash.test/graphql", subscriptions });

  const types: string[] = [];
  const jobs = stash.jobsSubscribe((update) => ({
    type: update.type,
    job: update.job((job) => ({ id: job.id })),
  }));
  for await (const update of jobs) {
    types.push(update.type);
    break;
  }
  expect(types).toEqual(["ADD"]);
  expect(unsubscribed).toBe(true);
  expect(requests[0]?.query).toBe("subscription{jobsSubscribe{type job{id}}}");
});

test("an idle subscription stops as soon as it is returned", async () => {
  const { source, stopped } = idleSubscription();
  const stash = createStash({
    endpoint: "http://stash.test/graphql",
    subscriptions: { iterate: () => source },
  });
  const updates = stash.scanCompleteSubscribe();
  void updates.next();
  await updates.return?.();
  expect(stopped()).toBe(true);
});

test("aborting ends a subscription like return()", async () => {
  const { source, stopped } = idleSubscription();
  const stash = createStash({
    endpoint: "http://stash.test/graphql",
    subscriptions: { iterate: () => source },
  });
  const controller = new AbortController();
  const updates = stash.scanCompleteSubscribe({ signal: controller.signal });
  const idle = updates.next();
  controller.abort();

  expect(await idle).toEqual({ value: undefined, done: true });
  expect(stopped()).toBe(true);
});

test("the signal of the client ends subscriptions too", async () => {
  const { source, stopped } = idleSubscription();
  const controller = new AbortController();
  const stash = createStash({
    endpoint: "http://stash.test/graphql",
    signal: controller.signal,
    subscriptions: { iterate: () => source },
  });
  const idle = stash.scanCompleteSubscribe().next();
  controller.abort();

  expect(await idle).toEqual({ value: undefined, done: true });
  expect(stopped()).toBe(true);
});

test("a subscription created with an aborted signal never connects", async () => {
  let connected = false;
  const stash = createStash({
    endpoint: "http://stash.test/graphql",
    subscriptions: {
      iterate() {
        connected = true;
        throw new Error("unreachable");
      },
    },
  });
  const updates = stash.scanCompleteSubscribe({ signal: AbortSignal.abort() });
  expect(await updates.next()).toEqual({ value: undefined, done: true });
  expect(connected).toBe(false);
});

test("a failing close on abort does not become an unhandled rejection", async () => {
  let finish: ((result: IteratorResult<unknown>) => void) | undefined;
  const stash = createStash({
    endpoint: "http://stash.test/graphql",
    subscriptions: {
      iterate: () => ({
        next: () => new Promise<IteratorResult<unknown>>((resolve) => (finish = resolve)),
        // Closing a subscription can fail, and the abort has no caller to report it to.
        async return() {
          finish?.({ value: undefined, done: true });
          throw new Error("close failed");
        },
        [Symbol.asyncIterator]() {
          return this;
        },
      }),
    },
  });
  const controller = new AbortController();
  const updates = stash.scanCompleteSubscribe({ signal: controller.signal });
  const idle = updates.next();
  controller.abort();

  expect(await idle).toEqual({ value: undefined, done: true });
  await new Promise((resolve) => setTimeout(resolve, 0));
});

test("subscription errors are thrown", async () => {
  const stash = createStash({
    endpoint: "http://stash.test/graphql",
    subscriptions: {
      async *iterate() {
        yield { errors: [{ message: "denied" }] };
      },
    },
  });
  const read = async () => {
    for await (const _ of stash.scanCompleteSubscribe()) return;
  };
  expect(read()).rejects.toThrow(StashError);
});

test("an error from the stream wins over a failing close", async () => {
  const source: AsyncIterableIterator<unknown> = {
    async next() {
      return { value: { errors: [{ message: "denied" }] }, done: false };
    },
    async return() {
      throw new Error("close failed");
    },
    [Symbol.asyncIterator]() {
      return this;
    },
  };
  const stash = createStash({
    endpoint: "http://stash.test/graphql",
    subscriptions: { iterate: () => source },
  });
  const error = await stash
    .scanCompleteSubscribe()
    .next()
    .catch((caught: unknown) => caught);
  expect(error instanceof StashError && error.message).toBe("denied");
});

test("sends files as a GraphQL multipart request", async () => {
  let body: unknown;
  const stash = createStash({
    endpoint: "http://stash.test/graphql",
    apiKey: "secret",
    fetch: async (_url, init) => {
      body = init.body;
      expect(init.headers).toEqual({ ApiKey: "secret" });
      return Response.json({ data: { importObjects: "job-1" } });
    },
  });
  const file = new Blob(["{}"], { type: "application/json" });
  const job: string = await stash.importObjects({
    input: { file, duplicateBehaviour: "IGNORE", missingRefBehaviour: "IGNORE" },
  });

  expect(job).toBe("job-1");
  if (!(body instanceof FormData)) throw new Error("expected multipart");
  expect(JSON.parse(text(body.get("map")))).toEqual({ 0: ["variables.input.file"] });
  expect(JSON.parse(text(body.get("operations"))).variables.input.file).toBeNull();
  expect(body.get("0")).toBeInstanceOf(Blob);
});

test("ordinary requests stay JSON", async () => {
  let contentType: string | undefined;
  const stash = createStash({
    endpoint: "http://stash.test/graphql",
    fetch: async (_url, init) => {
      contentType = new Headers(init.headers).get("content-type") ?? undefined;
      return Response.json({ data: { findScenes: { count: 1 } } });
    },
  });
  await stash.findScenes((found) => ({ count: found.count }));
  expect(contentType).toBe("application/json");
});

test("request passes any GraphQL document through", async () => {
  let sent: unknown;
  const stash = createStash({
    endpoint: "http://stash.test/graphql",
    fetch: async (_url, init) => {
      sent = typeof init.body === "string" ? JSON.parse(init.body) : undefined;
      return Response.json({ data: { a: { count: 1 }, b: { count: 2 } } });
    },
  });
  const query = "query($n:Int){a:findScenes(filter:{per_page:$n}){count} b:findImages{count}}";
  const data = await stash.request(query, { n: 1 });
  expect(sent).toEqual({ query, variables: { n: 1 } });
  expect(data).toEqual({ a: { count: 1 }, b: { count: 2 } });
});

test("a per-call signal reaches fetch, and only for that call", async () => {
  const signals: (AbortSignal | null | undefined)[] = [];
  const stash = createStash({
    endpoint: "http://stash.test/graphql",
    fetch: async (_url, init) => {
      signals.push(init.signal);
      return Response.json({
        data: {
          findScenes: { count: 1 },
          findScene: { id: "1" },
          performerDestroy: true,
          a: { count: 1 },
        },
      });
    },
  });
  const { signal } = new AbortController();

  // Without arguments the selection, or only the options, comes first.
  await stash.findScenes((found) => ({ count: found.count }), { signal });
  await stash.findScenes((found) => ({ count: found.count }));
  await stash.findScene({ id: "1" }, (scene) => ({ id: scene.id }), { signal });
  await stash.performerDestroy({ input: { id: "1" } }, { signal });
  await stash.request("{ a { count } }", {}, { signal });
  expect(signals).toEqual([signal, undefined, signal, signal, signal]);
});

test("a root field with arguments reads arguments before options", async () => {
  const bodies: unknown[] = [];
  const signals: (AbortSignal | null | undefined)[] = [];
  const stash = createStash({
    endpoint: "http://stash.test/graphql",
    fetch: async (_url, init) => {
      bodies.push(typeof init.body === "string" ? JSON.parse(init.body) : undefined);
      signals.push(init.signal);
      return Response.json({ data: { configureUI: {} } });
    },
  });
  const { signal } = new AbortController();
  await stash.configureUI({ input: { theme: "dark" } });
  // @ts-expect-error the types ask for arguments first, but plain JavaScript callers pass options
  await stash.configureUI({ signal });

  expect(bodies).toEqual([
    {
      query: "mutation($input:Map){configureUI(input:$input)}",
      variables: { input: { theme: "dark" } },
    },
    { query: "mutation{configureUI}", variables: {} },
  ]);
  expect(signals).toEqual([undefined, signal]);
});

test("a signal of another realm still reaches fetch", async () => {
  const signals: unknown[] = [];
  const stash = createStash({
    endpoint: "http://stash.test/graphql",
    fetch: async (_url, init) => {
      signals.push(init.signal);
      return Response.json({ data: { version: { version: "v0.31.1" } } });
    },
  });
  // A signal from an iframe is not an instance of this realm's AbortSignal, and fetch takes it.
  const signal = { aborted: false, addEventListener() {}, removeEventListener() {} };
  await stash.version(
    (info) => ({ version: info.version }),
    // @ts-expect-error only the shape of the signal matters here
    { signal },
  );
  expect(signals).toEqual([signal]);
});

test("aborting rejects the request with the AbortError of fetch", async () => {
  const stash = createStash({ endpoint: "http://stash.test/graphql", fetch: pendingFetch });
  const controller = new AbortController();
  const call = stash.findScenes((found) => ({ count: found.count }), {
    signal: controller.signal,
  });
  controller.abort();

  const error = await call.catch((caught: unknown) => caught);
  expect(error).toBe(controller.signal.reason);
  expect(error).toMatchObject({ name: "AbortError" });
});

test("timeoutMs gives every request a deadline", async () => {
  const stash = createStash({
    endpoint: "http://stash.test/graphql",
    timeoutMs: 5,
    fetch: pendingFetch,
  });
  const error = await stash
    .findScenes((found) => ({ count: found.count }))
    .catch((caught: unknown) => caught);
  expect(error).toMatchObject({ name: "TimeoutError" });
});

test("the signal of the client cancels a request that has a signal of its own", async () => {
  const controller = new AbortController();
  const stash = createStash({
    endpoint: "http://stash.test/graphql",
    signal: controller.signal,
    fetch: pendingFetch,
  });
  const call = stash.findScenes((found) => ({ count: found.count }), {
    signal: new AbortController().signal,
  });
  controller.abort();

  const error = await call.catch((caught: unknown) => caught);
  expect(error).toMatchObject({ name: "AbortError" });
});

/** A fetch that, like the real one, rejects when the signal of the request aborts. */
function pendingFetch(_url: string, init: RequestInit) {
  return new Promise<Response>((_resolve, reject) =>
    init.signal?.addEventListener("abort", () => reject(init.signal?.reason)),
  );
}

function text(value: unknown) {
  return typeof value === "string" ? value : "";
}

/** A source that stays idle until it is returned, like a subscription with nothing to send. */
function idleSubscription() {
  let stopped = false;
  let finish: ((result: IteratorResult<unknown>) => void) | undefined;
  const source: AsyncIterableIterator<unknown> = {
    next() {
      if (stopped) return Promise.resolve({ value: undefined, done: true });
      return new Promise((resolve) => {
        finish = resolve;
      });
    },
    // Like graphql-ws, the source resolves a pending next() when it is returned.
    async return() {
      stopped = true;
      finish?.({ value: undefined, done: true });
      return { value: undefined, done: true };
    },
    [Symbol.asyncIterator]() {
      return this;
    },
  };
  return { source, stopped: () => stopped };
}

test("keeps the partial data of a response that also has errors", async () => {
  const stash = createStash({
    endpoint: "http://stash.test/graphql",
    fetch: async () =>
      Response.json({ data: { findScenes: { count: 3 } }, errors: [{ message: "partial" }] }),
  });
  const error = await stash
    .findScenes((found) => ({ count: found.count }))
    .catch((caught: unknown) => caught);
  expect(error).toBeInstanceOf(StashError);
  expect(error instanceof StashError && error.data).toEqual({ findScenes: { count: 3 } });
});
