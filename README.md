# stash-graphql-client

A fully typed client for the [Stash](https://github.com/stashapp/stash) GraphQL API, without writing GraphQL.

- **Pick fields by reading them.** Your editor autocompletes them, and the result type has exactly the fields you picked.
- **Generated from Stash's own schema** (latest release, see `STASH_VERSION`), so the names match.
- **No dependencies.** It just uses `fetch`, and is about 4.5 KB gzipped.

```sh
bun add stash-graphql-client
```

## Quick start

```ts
import { createStash } from "stash-graphql-client";

const stash = createStash({
  endpoint: "http://localhost:9999/graphql",
  apiKey: process.env.STASH_API_KEY, // sent as the ApiKey header
});

// Every root field is a method: (arguments, what to select)
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

await stash.findPerformers((result) => ({ count: result.cont }));
//                                                      ~~~~ unknown field
```

## Good to know

- **Looking for a field or argument?** Everything is typed, with the schema's docs as JSDoc. In the installed package, see `dist/generated/schema.d.ts` for object and input types and `dist/generated/roots.d.ts` for the root fields.
- **Read scalars, call objects.** `found.title` selects a scalar; `found.studio(...)` selects an object with a nested selection.
- **Return only selections.** The returned object may contain just selected fields, nested selections and `$on` spreads. Compute things after the request, not inside the callback.
- **Reach for plain GraphQL last.** Use `stash.request` only for something the typed API can't express.

## Selecting fields

```ts
const scene = await stash.findScene({ id: "42" }, (found) => ({
  id: found.id,
  title: found.title, // string | null, same as in the schema
  studio: found.studio((studio) => ({ id: studio.id, name: studio.name })), // call it to pick nested fields
}));
```

Want a different name? Just use a different key. Fields with arguments can even be picked twice:

```ts
const { groups } = await stash.findGroups((result) => ({
  groups: result.groups((group) => ({
    id: group.id,
    rating: group.rating100,
    directScenes: group.scene_count({ depth: 0 }),
    allScenes: group.scene_count({ depth: -1 }),
  })),
}));
```

For unions and interfaces, use `$on` to pick fields of one type. `__typename` is added for you, so you can narrow on it:

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

Enums and input types are exported with the same names as in the schema:

```ts
import type { CriterionModifier, SceneFilterType } from "stash-graphql-client";

const favorites: SceneFilterType = {
  performer_favorite: true,
  rating100: { value: 80, modifier: "GREATER_THAN" satisfies CriterionModifier },
};

await stash.findScenes({ scene_filter: favorites }, (result) => ({ count: result.count }));
```

## Reusing selections

A selection is just a function, so you can share it like a fragment. `Fields` and `Result` are only types, so they cost nothing at runtime:

```ts
import type { Args, Fields, Result } from "stash-graphql-client";

const tagFields = ({ id, name }: Fields<"Tag">) => ({ id, name });

export const performerCard = (performer: Fields<"Performer">) => ({
  id: performer.id,
  name: performer.name,
  image: performer.image_path,
  tags: performer.tags(tagFields),
});

export type PerformerCard = Result<typeof performerCard>;
// { id: string; name: string; image: string | null; tags: { id: string; name: string }[] }

type ScenesArgs = Args<"findScenes">;

// Add parameters to make it configurable
const sceneCard = (scene: Fields<"Scene">, withFiles: boolean) => ({
  id: scene.id,
  tags: scene.tags(tagFields),
  ...(withFiles ? { files: scene.files(({ path, size }) => ({ path, size })) } : {}), // files?: ...
});
```

Callbacks run once, just to build the request, so don't `await` or do side effects in them. Destructuring the parameter picks those fields, but `...rest` picks nothing.

## Several root fields in one request

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

That's a single HTTP request, and the keys become aliases. `mutation` works the same way and runs in the order you wrote. A query and a mutation can't share a request, and Stash doesn't accept batched HTTP, so use `Promise.all` to run them side by side.

## Mutations and file uploads

```ts
const updated = await stash.performerUpdate(
  { input: { id: "3", favorite: true, rating100: 90 } },
  (performer) => ({ id: performer.id, favorite: performer.favorite }),
);

// Returns a plain boolean, so there's nothing to select
const deleted: boolean = await stash.performerDestroy({ input: { id: "3" } });

// Pass a Blob or File for uploads
const jobId = await stash.importObjects({
  input: {
    file: Bun.file("export.zip"),
    duplicateBehaviour: "IGNORE",
    missingRefBehaviour: "IGNORE",
  },
});
```

## Subscriptions

```ts
// Returns an async iterator; leaving the loop unsubscribes
const jobs = stash.jobsSubscribe((update) => ({
  type: update.type,
  job: update.job((job) => ({ id: job.id, progress: job.progress })),
}));

for await (const update of jobs) {
  console.log(update.type, update.job.progress);
  if (update.type === "REMOVE") break;
}
```

## Raw GraphQL and errors

```ts
import { StashError } from "stash-graphql-client";

try {
  // Send any GraphQL you like; the result is untyped
  await stash.request(`query ($id: ID!) { scene: findScene(id: $id) { id title } }`, { id: "42" });
} catch (error) {
  // If part of the request worked, that data is in error.data
  if (error instanceof StashError) console.error(error.status, error.errors);
}
```

## Options

```ts
createStash({
  endpoint: "https://stash.example.com/graphql",
  apiKey: "...",
  headers: { "X-Proxy-Token": "..." }, // e.g. for a reverse proxy
  fetch: (url, init) => fetch(url, { ...init, signal: AbortSignal.timeout(10_000) }), // or any fetch-like function
  // subscriptions: your own graphql-ws client
});
```

## Development

There's a script you can run against your own server in [`example/index.ts`](example/index.ts): `STASH_URL=http://localhost:9999 STASH_API_KEY=... bun example/index.ts`.

```sh
bun install
bun check          # type check
bun run lint       # oxfmt and oxlint
bun test           # also type-checks the examples in this README
bun run build      # writes dist
bun run schema     # update to the latest Stash release (or: bun run schema v0.30.0)
```

> [!NOTE]
> `@defer` isn't supported. Stash declares it but ignores it and always sends the full result.

> [!NOTE]
> This project was written with AI, and it runs in my own projects day to day. If you hit a bug, please [open an issue](https://github.com/shalemore/stash-graphql-client/issues/new/choose).
