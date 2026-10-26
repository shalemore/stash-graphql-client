# stash-graphql-client

[![npm](https://img.shields.io/npm/v/stash-graphql-client)](https://www.npmjs.com/package/stash-graphql-client)
[![CI](https://github.com/shalemore/stash-graphql-client/actions/workflows/ci.yml/badge.svg)](https://github.com/shalemore/stash-graphql-client/actions/workflows/ci.yml)
[![License](https://img.shields.io/npm/l/stash-graphql-client)](LICENSE)

A fully typed client for the [Stash](https://github.com/stashapp/stash) GraphQL API, without writing GraphQL.

- **Typed field selection.** Fields are selected with callbacks, and the result type contains exactly the selected fields.
- **Generated from Stash's own schema** (the latest release, see [Stash versions](#stash-versions)), so the names match.
- **Lightweight.** Built on `fetch`. Subscriptions need the optional `graphql-ws` package, which is loaded on first use.

```sh
npm install stash-graphql-client
```

## Quick start

```ts
import { createStash } from "stash-graphql-client";

const stash = createStash({
  endpoint: "http://localhost:9999/graphql",
  apiKey: process.env.STASH_API_KEY,
});

// Every root field is a method: (arguments, what to select)
const { count, performers } = await stash.findPerformers(
  { filter: { per_page: 20, sort: "name", direction: "ASC" } },
  (result) => ({
    ...result.$pick("count"),
    performers: result.performers((performer) => performer.$pick("id", "name", "favorite")),
  }),
);
// count: number
// performers: { id: string; name: string; favorite: boolean }[]

await stash.findPerformers((result) => result.$pick("cont"));
//                                                  ~~~~~~ unknown field
```

## Selecting fields

`$pick` selects scalar fields by name; an object field is called with its own selection:

```ts
const scene = await stash.findScene({ id: "42" }, (found) => ({
  ...found.$pick("id", "title"), // title: string | null, same as in the schema
  studio: found.studio((studio) => studio.$pick("id", "name")),
}));
```

A scalar can also be read directly, which selects it under the same name:

```ts
const scene = await stash.findScene({ id: "42" }, (found) => ({
  id: found.id,
  title: found.title,
  studio: found.studio((studio) => ({ id: studio.id, name: studio.name })),
}));
```

Use a different key to rename a field. A field with arguments can be selected more than once under different keys:

```ts
const { groups } = await stash.findGroups((result) => ({
  groups: result.groups((group) => ({
    ...group.$pick("id"),
    rating: group.rating100,
    directScenes: group.scene_count({ depth: 0 }),
    allScenes: group.scene_count({ depth: -1 }),
  })),
}));
```

For unions and interfaces, use `$on` to pick fields of one type. `__typename` is added automatically, so the result can be narrowed on it:

```ts
const image = await stash.findImage({ id: "7" }, (found) => ({
  visual_files: found.visual_files((file) => ({
    ...file.$on("ImageFile", (picture) => picture.$pick("path", "width")),
    ...file.$on("VideoFile", (video) => video.$pick("path", "duration")),
  })),
}));

for (const file of image?.visual_files ?? []) {
  if (file.__typename === "ImageFile") console.log(file.width);
}
```

Enums and input types are exported with the same names as in the schema:

```ts
import type { CriterionModifier, SceneFilterType } from "stash-graphql-client";

const favorites: SceneFilterType = {
  performer_favorite: true,
  rating100: { value: 80, modifier: "GREATER_THAN" satisfies CriterionModifier },
};

await stash.findScenes({ scene_filter: favorites }, (result) => result.$pick("count"));
```

## Reusing selections

A selection is a plain function, so it can be shared like a GraphQL fragment. `Fields` and `Result` are types only and have no runtime cost:

```ts
import type { Args, Fields, Result } from "stash-graphql-client";

const tagFields = (tag: Fields<"Tag">) => tag.$pick("id", "name");

export const performerCard = (performer: Fields<"Performer">) => ({
  ...performer.$pick("id", "name"),
  image: performer.image_path,
  tags: performer.tags(tagFields),
});

export type PerformerCard = Result<typeof performerCard>;
// { id: string; name: string; image: string | null; tags: { id: string; name: string }[] }

// Add parameters to make it configurable
const sceneCard = (scene: Fields<"Scene">, withFiles: boolean) => ({
  ...scene.$pick("id"),
  tags: scene.tags(tagFields),
  ...(withFiles ? { files: scene.files((file) => file.$pick("path", "size")) } : {}), // files?: ...
});

// Args is the argument type of a root field, handy for wrapping a call in your own function
const listScenes = (args: Args<"findScenes">) =>
  stash.findScenes(args, (result) => ({
    ...result.$pick("count"),
    scenes: result.scenes((scene) => sceneCard(scene, false)),
  }));
```

Callbacks run once, only to build the request. They must return only fields, nested selections and `$on` spreads. Don't `await` or compute anything inside them; do that with the result instead.

> [!WARNING]
> Don't use `...rest` on the callback parameter. It is always empty, so nothing is selected.

## Several root fields in one request

```ts
const totals = await stash.query((query) => ({
  scenes: query.findScenes((result) => result.$pick("count")),
  favorites: query.findScenes({ scene_filter: { performer_favorite: true } }, (result) =>
    result.$pick("count"),
  ),
  performers: query.findPerformers((result) => result.$pick("count")),
}));

totals.favorites.count; // number
```

This sends a single HTTP request, and the keys become aliases. `mutation` works the same way and runs the fields in the order written. A query and a mutation can't share a request, and Stash doesn't accept batched HTTP, so use `Promise.all` to run them concurrently.

## Mutations and file uploads

```ts
import { openAsBlob } from "node:fs";

const updated = await stash.performerUpdate(
  { input: { id: "3", favorite: true, rating100: 90 } },
  (performer) => performer.$pick("id", "favorite"),
);

// Returns a plain boolean, so there's nothing to select
const deleted: boolean = await stash.performerDestroy({ input: { id: "3" } });

// Pass a Blob or File for uploads: openAsBlob on Node, Bun.file on Bun, or a file input in the browser
const jobId = await stash.importObjects({
  input: {
    file: await openAsBlob("export.zip"),
    duplicateBehaviour: "IGNORE",
    missingRefBehaviour: "IGNORE",
  },
});
```

## Subscriptions

```ts
// Returns an async iterator; leaving the loop unsubscribes
const jobs = stash.jobsSubscribe((update) => ({
  ...update.$pick("type"),
  job: update.job((job) => job.$pick("id", "progress")),
}));

for await (const update of jobs) {
  console.log(update.type, update.job.progress);
  if (update.type === "REMOVE") break;
}
```

Subscriptions go over a WebSocket through [`graphql-ws`](https://github.com/enisdenjo/graphql-ws), an optional peer dependency that is loaded on first use:

```sh
npm install graphql-ws
```

The client is created on the first subscription, at the same address as `endpoint` (`http` becomes `ws`, `https` becomes `wss`).

- **Authentication.** On Node.js and Bun, `apiKey` and `headers` are sent with the WebSocket handshake too. Browsers can't set headers on a WebSocket, so there Stash has to recognize the session cookie.
- **Needs a `WebSocket`.** That is global in browsers, on Node.js 22+ and on Bun. On older versions, or to configure reconnecting, pass your own `graphql-ws` client. A custom client must also handle authentication.

```ts
import { createClient } from "graphql-ws";

const stash = createStash({
  endpoint: "http://localhost:9999/graphql",
  subscriptions: createClient({
    url: "ws://localhost:9999/graphql",
    webSocketImpl: WebSocket, // e.g. the `ws` package on older Node.js
    retryAttempts: Infinity,
  }),
});
```

## Raw GraphQL and errors

```ts
import { StashError } from "stash-graphql-client";

try {
  // For what the typed API can't express; the result is untyped
  await stash.request(`query ($id: ID!) { scene: findScene(id: $id) { id title } }`, { id: "42" });
} catch (error) {
  // If part of the request worked, that data is in error.data
  if (error instanceof StashError) console.error(error.status, error.errors);
}
```

## Cancellation and timeouts

Every method takes an optional last argument with an `AbortSignal`, as `fetch` does:

```ts
const controller = new AbortController();
const found = stash.findScenes((result) => result.$pick("count"), { signal: controller.signal });
controller.abort(); // `found` rejects with the AbortError of fetch, and the request is dropped

// A deadline needs no controller
const scene = await stash.findScene({ id: "42" }, (scene) => scene.$pick("title"), {
  signal: AbortSignal.timeout(5_000),
});

// A subscription ends instead of throwing, as if the loop was left
const stopping = new AbortController();
for await (const update of stash.jobsSubscribe((update) => update.$pick("type"), {
  signal: stopping.signal,
})) {
  console.log(update.type);
}
```

An aborted request rejects with the same `AbortError` that `fetch` throws, so `error.name === "AbortError"` tells it apart from a `StashError`. A deadline rejects with a `TimeoutError`. Combine signals with `AbortSignal.any([...])`.

To apply a deadline or a signal to every call instead, pass `timeoutMs` or `signal` to `createStash`, see [Options](#options). A signal of the client cancels the requests in flight on top of their own signals.

## Options

```ts
const closing = new AbortController();

createStash({
  endpoint: "https://stash.example.com/graphql",
  apiKey: "...",
  headers: { "X-Proxy-Token": "..." }, // e.g. for a reverse proxy
  timeoutMs: 30_000, // deadline for every request
  signal: closing.signal, // cancels every request and subscription
  fetch: (url, init) => fetch(url, init), // or any fetch-like function
  // subscriptions: your own graphql-ws client, see Subscriptions
});
```

## Stash versions

Package `0.31.x` tracks the Stash `v0.31` series; patch numbers are independent. `STASH_VERSION` is the Stash release the schema comes from.

## License

[MIT](LICENSE)
