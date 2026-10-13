# stash-graphql-client

A fully typed client for the [Stash](https://github.com/stashapp/stash) GraphQL API, without writing GraphQL.

- **Select fields by reading them.** A selection is a callback that picks fields from a typed object, so the editor completes field names and shows each field's type, docs and deprecation. Only the selected fields are requested, and the result type contains exactly those fields with the nullability from the schema.
- **Everything comes from the schema.** Root fields, arguments, input types and enums are generated from Stash's own schema with the same names. There are no hand-written wrappers to fall behind upstream.
- **No runtime dependencies.** It uses the platform `fetch` and bundles to about 4.5 KB gzipped. Turning a selection into a request takes about 4.5 µs.
- **Covers the whole API.** Queries, mutations, subscriptions (via [`graphql-ws`](https://github.com/enisdenjo/graphql-ws)) and file uploads are supported. `@defer` is the one thing left out: Stash declares it but ignores it and always answers with the complete result. Anything else can be sent as a plain GraphQL document.

Generated from the official schema of the latest Stash release (exported as `STASH_VERSION`), with its field descriptions and deprecations as JSDoc.

```sh
bun add stash-graphql-client
```

## Quick start

```ts
import { createStash } from "stash-graphql-client";

const stash = createStash({
  endpoint: "http://localhost:9999/graphql",
  apiKey: process.env.STASH_API_KEY,
});

const { count, performers } = await stash.findPerformers(
  { filter: { per_page: 20, sort: "name", direction: "ASC" } },
  (result) => ({
    count: result.count,
    performers: result.performers((performer) => ({
      id: performer.id,
      name: performer.name,
      favorite: performer.favorite,
    })),
  }),
);
// count: number
// performers: { id: string; name: string; favorite: boolean }[]
```

Every root field of the schema is a method. Its first parameter is the arguments, which can be left out when none is required, and its last is the selection. Mistakes are caught by the type checker:

```ts
await stash.findPerformers((result) => ({ count: result.cont }));
//                                                      ~~~~ unknown field
await stash.findPerformers({ filter: { direction: "UP" } }, (result) => ({ count: result.count }));
//                                     ~~~~~~~~~ not a SortDirectionEnum
```

## Selecting fields

The selection callback receives the fields of the returned object type. Read a scalar field to select it, and call an object field with a nested selection:

```ts
const scene = await stash.findScene({ id: "42" }, (found) => ({
  id: found.id,
  title: found.title,
  rating100: found.rating100,
  studio: found.studio((studio) => ({ id: studio.id, name: studio.name })),
  files: found.files((file) => ({ path: file.path, duration: file.duration })),
}));
// scene: { id: string; title: string | null; rating100: number | null;
//   studio: { id: string; name: string } | null; files: { ... }[] } | null
```

### Names, aliases and arguments

The keys of the returned object are the keys of the result, so renaming a field is just a different key. Fields with arguments are called with them, which also lets you select the same field twice:

```ts
const { groups } = await stash.findGroups((result) => ({
  groups: result.groups((group) => ({
    id: group.id,
    rating: group.rating100,
    directScenes: group.scene_count({ depth: 0 }),
    allScenes: group.scene_count({ depth: -1 }),
  })),
}));
// groups: { id: string; rating: number | null; directScenes: number; allScenes: number }[]
```

### Unions and interfaces

Spread `$on` into the selection to select fields of one member. `__typename` is requested automatically, and the result is narrowed by it:

```ts
const image = await stash.findImage({ id: "7" }, (found) => ({
  visual_files: found.visual_files((file) => ({
    ...file.$on("ImageFile", (picture) => ({ path: picture.path, width: picture.width })),
    ...file.$on("VideoFile", (video) => ({ path: video.path, duration: video.duration })),
  })),
}));

for (const file of image?.visual_files ?? []) {
  if (file.__typename === "ImageFile") console.log(file.width);
}
```

### Filters, enums and input types

Every enum and input type of the schema is exported under its original name:

```ts
import type { CriterionModifier, SceneFilterType } from "stash-graphql-client";

const favorites: SceneFilterType = {
  performer_favorite: true,
  rating100: { value: 80, modifier: "GREATER_THAN" satisfies CriterionModifier },
};

await stash.findScenes({ scene_filter: favorites }, (result) => ({ count: result.count }));
```

## Reusing selections and naming types

A selection is a plain function, so share it like a fragment. Annotate its parameter with `Fields<"Type">` and derive its result with `Result`; both are types only, so nothing extra is imported at runtime:

```ts
import type { Fields, Result } from "stash-graphql-client";

const tagFields = ({ id, name }: Fields<"Tag">) => ({ id, name });

export const performerCard = (performer: Fields<"Performer">) => ({
  id: performer.id,
  name: performer.name,
  image: performer.image_path,
  tags: performer.tags(tagFields),
});

export type PerformerCard = Result<typeof performerCard>;
// { id: string; name: string; image: string | null; tags: { id: string; name: string }[] }

const { performers } = await stash.findPerformers((result) => ({
  performers: result.performers(performerCard),
}));
// performers: PerformerCard[]
```

| Type                                      | Meaning                                      |
| ----------------------------------------- | -------------------------------------------- |
| `Fields<"Performer">`                     | The fields a selection can pick on an object |
| `Result<typeof select>`                   | The result of a selection callback           |
| `Args<"findScenes">`                      | Arguments of a root field                    |
| `SceneFilterType`, `GenderEnum` and so on | Every input type and enum of the schema      |

## Writing selections

A selection callback is ordinary TypeScript, so the usual tools work. These conventions keep selections short and their types readable.

### Destructure when the keys stay the same

Destructuring reads the fields, so it selects them. Use it in leaf selections whose result keys are the field names, and use the dotted form to rename a field:

```ts
const { count, groups } = await stash.findGroups((found) => ({
  count: found.count,
  groups: found.groups(({ id, name, rating100, tags }) => ({
    id,
    name,
    rating: rating100,
    tags: tags(tagFields),
  })),
}));
```

Use a named parameter where destructured names would shadow variables around it, as in the root callback above, whose result is destructured into the same names. With a `no-shadow` lint rule this matters for nested selections too: two levels that both destructure `id` and `name` shadow each other, so pass a shared selection such as `tagFields` instead.

Destructure only the fields you select. A rest element (`({ id, ...rest })`) selects nothing, because the fields object has no own keys to copy.

### Share selections as module-level functions

Write a selection that is used more than once as a function at module level, typed with `Fields<"Type">` and named after the object type: `tagFields`, `performerCard`. Derive types from it with `Result` instead of declaring them by hand, so the type can never drift from what is requested:

```ts
const tagFields = ({ id, name }: Fields<"Tag">) => ({ id, name });

export const sceneFields = (scene: Fields<"Scene">) => ({
  id: scene.id,
  title: scene.title,
  tags: scene.tags(tagFields),
  performers: scene.performers(({ id, name }) => ({ id, name })),
});

export type SceneItem = Result<typeof sceneFields>;
```

A selection that is used once stays inline in the call.

### Compose and parameterize

Pass a shared selection to an object field, or spread it to extend it. Extra parameters after the fields make a selection configurable; a field selected with a conditional spread is optional in the result:

```ts
const tagTree = (tag: Fields<"Tag">) => ({
  ...tagFields(tag),
  children: tag.children(tagFields),
});

const sceneCard = (scene: Fields<"Scene">, withFiles: boolean) => ({
  ...sceneFields(scene),
  ...(withFiles ? { files: scene.files(({ path, size }) => ({ path, size })) } : {}),
});

const { scenes } = await stash.findScenes((found) => ({
  scenes: found.scenes((scene) => sceneCard(scene, true)),
}));
// scenes: { id: string; ...; files?: { path: string; size: number }[] }[]
```

### Keep callbacks synchronous and pure

Selection callbacks run once, while the request is built, and only record what they read. Don't await in them or depend on side effects. Everything in the returned object must be a selected field, a nested selection or a `$on` spread; other values are a type error and are rejected before sending.

### Pick the right request

- One root field: call its method, `stash.findScenes(...)`.
- Several root fields that belong together, such as the counts of a dashboard: `stash.query(...)`, which sends one request.
- Independent requests: run the methods concurrently with `Promise.all`.
- Mutations: select what the caller needs afterwards, typically the id and the fields it changed, so a cache can be updated without refetching.

## Several root fields in one request

`query` selects any number of root fields. The keys become aliases, so the same root field can appear twice with different arguments:

```ts
const totals = await stash.query((query) => ({
  scenes: query.findScenes((result) => ({ count: result.count })),
  favorites: query.findScenes({ scene_filter: { performer_favorite: true } }, (result) => ({
    count: result.count,
  })),
  performers: query.findPerformers((result) => ({ count: result.count })),
}));

totals.favorites.count; // number
```

This is one HTTP request and one GraphQL document, so Stash answers once. `mutation` works the same way for mutations, which the GraphQL spec runs one after another in the order you wrote them.

Two limits:

- A query and a mutation can't share a request in GraphQL. Await them separately.
- Sending an array of separate operations in one HTTP request (batched HTTP) isn't part of the GraphQL spec, and Stash rejects it. Use `Promise.all` to run requests concurrently.

If one field fails, the request throws a `StashError`; the fields that did succeed are on `error.data`.

## Mutations and file uploads

Mutations work like queries. Mutations that return a scalar take no selection:

```ts
const updated = await stash.performerUpdate(
  { input: { id: "3", favorite: true, rating100: 90 } },
  (performer) => ({ id: performer.id, favorite: performer.favorite }),
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
const jobs = stash.jobsSubscribe((update) => ({
  type: update.type,
  job: update.job((job) => ({ id: job.id, progress: job.progress })),
}));

for await (const update of jobs) {
  console.log(update.type, update.job.progress);
  if (update.type === "REMOVE") break;
}
```

The protocol is handled by [`graphql-ws`](https://github.com/enisdenjo/graphql-ws), the reference implementation. It is loaded on the first subscription only, so code without subscriptions never bundles it. In Bun and Node the API key is sent on the WebSocket upgrade request; browsers authenticate with the session cookie. Pass `subscriptions` to use your own `graphql-ws` client instead.

## Any other GraphQL

`request` sends a GraphQL document as is. Use it for anything the typed API doesn't model, such as directives. The result is untyped:

```ts
const data = await stash.request(`query ($id: ID!) { scene: findScene(id: $id) { id title } }`, {
  id: "42",
});
```

## Errors

Failed requests throw a `StashError` with the HTTP status and the GraphQL errors. GraphQL may return data next to errors; that partial `data` is available on the error. Stash validates arguments on the server, so a value that slips past the type checker comes back as a readable error:

```ts
import { StashError } from "stash-graphql-client";

try {
  await stash.findScene({ id: "42" }, (found) => ({ id: found.id }));
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

## How it works

The `fields` object passed to a selection callback is a small proxy that records which fields you read and call. It needs no schema at runtime: the types already guarantee that only existing fields are selected. The client only carries the GraphQL types of root field arguments, which it needs to declare variables. That is why selections, `Fields` and `Result` add nothing to your bundle.

## Example

[`example/index.ts`](example/index.ts) is a small script that uses the library like any project would: several root fields in one request, filters, reusable selections, file dimensions through `$on`, errors and subscriptions. Run it with `STASH_URL=http://localhost:9999 STASH_API_KEY=... bun example/index.ts`.

## Development

```sh
bun install
bun check          # type check, including the README examples
bun run lint       # oxfmt and oxlint
bun test
bun run build      # writes dist
```

The generated code in `src/generated` is committed, so nothing has to be generated after cloning. To update to the latest Stash release, run `bun run schema` (or `bun run schema v0.30.0` for a specific one). It downloads the schema from the official repository, including its field descriptions, which show up in your editor.
