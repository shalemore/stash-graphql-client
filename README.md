# @shalemore/stash-api

A fully typed client for the [Stash](https://github.com/stashapp/stash) GraphQL API, without writing GraphQL.

- **Pick fields with plain objects.** Only the selected fields are requested, and the result type contains exactly those fields with the nullability from the schema.
- **Everything comes from the schema.** Root fields, arguments, input types and enums are generated from Stash's own schema with the same names. There are no hand-written wrappers to fall behind upstream.
- **No runtime dependencies.** It uses the platform `fetch`. Turning a selection into a request takes about 4 µs, roughly 10x faster than printing a GraphQL document.
- **Covers the whole API.** Queries, mutations, subscriptions (via [`graphql-ws`](https://github.com/enisdenjo/graphql-ws)) and file uploads are supported. `@defer` is the one thing left out: Stash declares it but ignores it and always answers with the complete result. Anything else can be sent as a plain GraphQL document.

Generated from the official schema of the latest Stash release (exported as `STASH_VERSION`), with its field descriptions and deprecations as JSDoc.

```sh
bun add @shalemore/stash-api
```

## Quick start

```ts
import { createStash } from "@shalemore/stash-api";

const stash = createStash({
  endpoint: "http://localhost:9999/graphql",
  apiKey: process.env.STASH_API_KEY,
});

const { count, performers } = await stash.findPerformers(
  { filter: { per_page: 20, sort: "name", direction: "ASC" } },
  { count: true, performers: { id: true, name: true, favorite: true } },
);
// count: number
// performers: { id: string; name: string; favorite: boolean }[]
```

Every root field of the schema is a method. Its first parameter is the arguments and its second is the selection. Mistakes are caught by the type checker:

```ts
await stash.findPerformers(undefined, { performers: { nam: true } });
//                                                    ~~~ unknown field
await stash.findPerformers({ filter: { direction: "UP" } }, { count: true });
//                                                ~~~~ not a SortDirectionEnum
```

## Selecting fields

Use `true` for scalars and a nested object for object fields:

```ts
const scene = await stash.findScene(
  { id: "42" },
  {
    id: true,
    title: true,
    rating100: true,
    studio: { id: true, name: true },
    performers: { id: true, name: true },
    files: { path: true, duration: true },
  },
);
// scene: { id: string; title: string | null; rating100: number | null;
//   studio: { id: string; name: string } | null; ... } | null
```

### Arguments on nested fields

Fields that take arguments accept them through `$args`:

```ts
const { groups } = await stash.findGroups(undefined, {
  groups: { id: true, name: true, scene_count: { $args: { depth: -1 } } },
});
```

### Aliases

Select the same field twice with different arguments by giving each one a name under `$as`. Each alias selects exactly one field:

```ts
const { files } = await stash.findFiles(undefined, {
  files: {
    path: true,
    $as: {
      md5: { fingerprint: { $args: { type: "md5" } } },
      phash: { fingerprint: { $args: { type: "phash" } } },
    },
  },
});
// files: { path: string; md5: string | null; phash: string | null }[]
```

### Unions and interfaces

Select per member with `$on`. The result is narrowed by `__typename`:

```ts
const image = await stash.findImage(
  { id: "7" },
  { visual_files: { $on: { ImageFile: { path: true, width: true, height: true } } } },
);

for (const file of image?.visual_files ?? []) {
  if (file.__typename === "ImageFile") console.log(file.width, file.height);
}
```

### Filters, enums and input types

Every enum and input type of the schema is exported under its original name:

```ts
import type { CriterionModifier, SceneFilterType } from "@shalemore/stash-api";

const favorites: SceneFilterType = {
  performer_favorite: true,
  rating100: { value: 80, modifier: "GREATER_THAN" satisfies CriterionModifier },
};

await stash.findScenes({ scene_filter: favorites }, { count: true });
```

## Reusing selections and naming types

A selection is a plain object, so share it like a fragment and derive its type with `Result`:

```ts
import type { Result, Selection } from "@shalemore/stash-api";

export const performerCard = {
  id: true,
  name: true,
  image_path: true,
  tags: { id: true, name: true },
} as const satisfies Selection<"Performer">;

export type PerformerCard = Result<"Performer", typeof performerCard>;

const { performers } = await stash.findPerformers(undefined, { performers: performerCard });
// performers: PerformerCard[]
```

| Type                                      | Meaning                                           |
| ----------------------------------------- | ------------------------------------------------- |
| `Selection<"Performer">`                  | What can be selected on an object type            |
| `Result<"Performer", typeof s>`           | Result of selection `s` on an object type         |
| `Args<"findScenes">`                      | Arguments of a root field                         |
| `OperationResult<"findScenes", typeof s>` | Result of calling a root field with selection `s` |
| `ResultOf<typeof op>`                     | Result of an operation created with `operation()` |
| `SceneFilterType`, `GenderEnum` and so on | Every input type and enum of the schema           |

## Several root fields in one request

Describe each call with `operation()` and send them together. The keys become aliases:

```ts
import { operation } from "@shalemore/stash-api";

const totals = await stash.batch({
  scenes: operation("findScenes", undefined, { count: true }),
  images: operation("findImages", undefined, { count: true }),
  performers: operation("findPerformers", undefined, { count: true }),
});

totals.scenes.count; // number
```

## Mutations and file uploads

Mutations work like queries. Mutations that return a scalar take no selection:

```ts
const updated = await stash.performerUpdate(
  { input: { id: "3", favorite: true, rating100: 90 } },
  { id: true, favorite: true, rating100: true },
);

const deleted: boolean = await stash.performerDestroy({ input: { id: "3" } });
```

Pass a `Blob` or `File` where the schema expects an `Upload`. Such requests are sent as a [GraphQL multipart request](https://github.com/jaydenseric/graphql-multipart-request-spec):

```ts
const jobId = await stash.importObjects({
  input: {
    file: Bun.file("export.zip"),
    duplicateBehaviour: "IGNORE",
    missingRefBehaviour: "IGNORE",
  },
});
```

## Subscriptions

Stash streams job updates, logs and scan completion over WebSocket. Subscription methods return async iterators, and leaving the loop unsubscribes:

```ts
for await (const update of stash.jobsSubscribe(undefined, {
  type: true,
  job: { id: true, description: true, progress: true },
})) {
  console.log(update.type, update.job.progress);
  if (update.type === "REMOVE") break;
}
```

The protocol is handled by [`graphql-ws`](https://github.com/enisdenjo/graphql-ws), the reference implementation. It is loaded on the first subscription only, so code without subscriptions never bundles it. In Bun and Node the API key is sent on the WebSocket upgrade request; browsers authenticate with the session cookie. Pass `subscriptions` to use your own `graphql-ws` client instead.

## Any other GraphQL

`request` sends a GraphQL document as is. Use it for anything the typed API doesn't model, such as fragments or directives. The result is untyped:

```ts
const data = await stash.request(`query ($id: ID!) { scene: findScene(id: $id) { id title } }`, {
  id: "42",
});
```

To use another GraphQL client, `buildRequest` returns the standard `{ query, variables }` body for any operation:

```ts
import { buildRequest, operation } from "@shalemore/stash-api";

const body = buildRequest([[undefined, operation("findScenes", undefined, { count: true })]]);
// { query: "query{findScenes{count}}", variables: {} }
```

## Errors

Failed requests throw a `StashError` with the HTTP status and the GraphQL errors. GraphQL may return data next to errors; that partial `data` is available on the error. Stash validates arguments on the server, so a typo that slips past the type checker comes back as a readable error:

```ts
import { StashError } from "@shalemore/stash-api";

try {
  await stash.findScene({ id: "42" }, { id: true });
} catch (error) {
  if (error instanceof StashError) console.error(error.status, error.errors);
}
```

## Options

```ts
createStash({
  endpoint: "https://stash.example.com/graphql",
  apiKey: "...", // sent as the ApiKey header
  headers: { "X-Proxy-Token": "..." }, // extra headers, e.g. for a reverse proxy
  fetch: (url, init) => fetch(url, { ...init, signal: AbortSignal.timeout(10_000) }),
});
```

## Smaller bundles

`createStash` carries the argument types of every root field, so it bundles to about 4.5 KB gzipped (plus a lazily loaded 4 KB chunk for subscriptions that is only fetched when you subscribe). For the smallest browser bundles, import operations one by one from `@shalemore/stash-api/operations` and run them with `createRunner`; unused operations are tree-shaken away, and a single operation bundles to under 2 KB:

```ts
import { createRunner, findScenes } from "@shalemore/stash-api/operations";

const stash = createRunner({ endpoint: "/graphql" });
const { count } = await stash.run(findScenes(undefined, { count: true }));
```

## Example

[`example/index.ts`](example/index.ts) is a small script that uses the library like any project would: batching, filters, reusable selections, file dimensions through `$on`, errors and subscriptions. Run it with `STASH_URL=http://localhost:9999 STASH_API_KEY=... bun example/index.ts`.

## Development

```sh
bun install
bun check          # type check, including the README examples
bun run lint       # oxfmt and oxlint
bun test
bun run build      # writes dist
```

The generated code in `src/generated` is committed, so nothing has to be generated after cloning. To update to the latest Stash release, run `bun run schema` (or `bun run schema v0.30.0` for a specific one). It downloads the schema from the official repository, including its field descriptions, which show up in your editor.
