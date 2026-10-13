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
  let stopped = false;
  const source: AsyncIterableIterator<unknown> = {
    next: () => new Promise(() => {}),
    return: async () => {
      stopped = true;
      return { value: undefined, done: true };
    },
    [Symbol.asyncIterator]() {
      return this;
    },
  };
  const stash = createStash({
    endpoint: "http://stash.test/graphql",
    subscriptions: { iterate: () => source },
  });
  const updates = stash.scanCompleteSubscribe();
  void updates.next();
  await updates.return?.();
  expect(stopped).toBe(true);
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

function text(value: unknown) {
  return typeof value === "string" ? value : "";
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
