/**
 * Compile-time tests: `bun check` verifies the types, so the functions below are never called.
 */
import { expect, expectTypeOf, test } from "bun:test";

import type { StashClient } from "./client.ts";
import type { JobStatusUpdateType, Objects } from "./generated/schema.ts";
import type { R } from "./index.ts";
import type { Fields, Result } from "./types.ts";

async function resultTypes(stash: StashClient) {
  const found = await stash.findPerformers({ filter: { per_page: 1 } }, (result) => ({
    count: result.count,
    performers: result.performers((performer) => ({
      id: performer.id,
      name: performer.name,
      rating100: performer.rating100,
      tags: performer.tags((tag) => ({ name: tag.name })),
    })),
  }));
  expectTypeOf(found).toEqualTypeOf<{
    count: number;
    performers: {
      id: string;
      name: string;
      rating100: number | null;
      tags: { name: string }[];
    }[];
  }>();

  // Arguments can be left out when none is required; nullable objects stay nullable.
  const version = await stash.version((v) => ({ version: v.version }));
  expectTypeOf(version).toEqualTypeOf<{ version: string | null }>();
  const scene = await stash.findScene({ id: "1" }, (s) => ({ title: s.title }));
  expectTypeOf(scene).toEqualTypeOf<{ title: string | null } | null>();

  // Scalar root fields take no selection.
  expectTypeOf(await stash.performerDestroy({ input: { id: "1" } })).toEqualTypeOf<boolean>();
}

async function aliasTypes(stash: StashClient) {
  // Result keys are aliases, so the same field can be selected with different arguments.
  const { groups } = await stash.findGroups((result) => ({
    groups: result.groups((group) => ({
      id: group.id,
      rating: group.rating100,
      direct: group.scene_count({ depth: 0 }),
      all: group.scene_count({ depth: -1 }),
      count: group.scene_count,
    })),
  }));
  expectTypeOf(groups).toEqualTypeOf<
    { id: string; rating: number | null; direct: number; all: number; count: number }[]
  >();

  const totals = await stash.query((query) => ({
    scenes: query.findScenes((result) => ({ count: result.count })),
    favorites: query.findScenes({ scene_filter: { performer_favorite: true } }, (result) => ({
      count: result.count,
    })),
    version: query.version((v) => ({ version: v.version })),
  }));
  expectTypeOf(totals).toEqualTypeOf<{
    scenes: { count: number };
    favorites: { count: number };
    version: { version: string | null };
  }>();

  const updated = await stash.mutation((mutation) => ({
    first: mutation.performerUpdate({ input: { id: "1" } }, (performer) => ({ id: performer.id })),
    removed: mutation.performerDestroy({ input: { id: "2" } }),
  }));
  expectTypeOf(updated).toEqualTypeOf<{ first: { id: string } | null; removed: boolean }>();
}

async function pickTypes(stash: StashClient) {
  // $pick gives the same result as selecting the fields one by one, and can be spread or returned.
  const scene = await stash.findScene({ id: "1" }, (s) => ({
    ...s.$pick("id", "title"),
    studio: s.studio((studio) => studio.$pick("name")),
  }));
  expectTypeOf(scene).toEqualTypeOf<{
    id: string;
    title: string | null;
    studio: { name: string } | null;
  } | null>();

  // Fields with optional arguments can be picked without them.
  const { groups } = await stash.findGroups((result) => ({
    groups: result.groups((group) => group.$pick("id", "scene_count")),
  }));
  expectTypeOf(groups).toEqualTypeOf<{ id: string; scene_count: number }[]>();
}

async function unionTypes(stash: StashClient) {
  const { files } = await stash.findFiles((result) => ({
    files: result.files((file) => ({
      path: file.path,
      ...file.$on("ImageFile", (image) => ({ width: image.width, height: image.height })),
      ...file.$on("VideoFile", (video) => ({ width: video.width, duration: video.duration })),
    })),
  }));
  for (const file of files) {
    expectTypeOf(file.path).toBeString();
    if (file.__typename === "VideoFile") expectTypeOf(file.duration).toBeNumber();
    else if (file.__typename === "ImageFile") expectTypeOf(file).not.toHaveProperty("duration");
    // @ts-expect-error width is only selected on images and videos
    else void file.width;
  }
}

const tagFields = (tag: Fields<"Tag">) => ({ id: tag.id, name: tag.name });
const performerCard = (performer: Fields<"Performer">) => ({
  id: performer.id,
  name: performer.name,
  tags: performer.tags(tagFields),
});
const fileFields = (file: Fields<"BaseFile">) => ({
  path: file.path,
  ...file.$on("VideoFile", (video) => ({ duration: video.duration })),
});

const tagNames = ({ id, name }: Fields<"Tag">) => ({ id, name });
const tagPicked = (tag: Fields<"Tag">) => tag.$pick("id", "name");
const optionalTags = (performer: Fields<"Performer">, withTags: boolean) => ({
  id: performer.id,
  ...(withTags ? { tags: performer.tags(tagNames) } : {}),
});

function reusableSelections() {
  // Destructured fields keep their names, so the result keys equal the field names.
  expectTypeOf<Result<typeof tagNames>>().toEqualTypeOf<{ id: string; name: string }>();
  expectTypeOf<Result<typeof tagPicked>>().toEqualTypeOf<{ id: string; name: string }>();
  // A field selected conditionally is optional in the result.
  expectTypeOf<Result<typeof optionalTags>>().toEqualTypeOf<{
    id: string;
    tags?: { id: string; name: string }[];
  }>();

  expectTypeOf<Result<typeof tagFields>>().toEqualTypeOf<{ id: string; name: string }>();
  expectTypeOf<Result<typeof performerCard>>().toEqualTypeOf<{
    id: string;
    name: string;
    tags: { id: string; name: string }[];
  }>();
  expectTypeOf<Result<typeof fileFields>>().toEqualTypeOf<
    | { path: string; __typename: "BasicFile" }
    | { path: string; __typename: "VideoFile"; duration: number }
    | { path: string; __typename: "ImageFile" }
    | { path: string; __typename: "GalleryFile" }
  >();
}

function generatedShapes() {
  // Generated field types are plain shapes: one wrapper per object reference, native lists and null.
  expectTypeOf<Objects["Tag"]["parents"]>().toEqualTypeOf<R<"Tag">[]>();
  expectTypeOf<Objects["Tag"]["sort_name"]>().toEqualTypeOf<string | null>();
}

async function perCallOptions(stash: StashClient, signal: AbortSignal) {
  // Every method takes a trailing options argument, for cancellation; results are unchanged.
  expectTypeOf(
    await stash.findScenes((found) => ({ count: found.count }), { signal }),
  ).toEqualTypeOf<{ count: number }>();
  expectTypeOf(
    await stash.findScene({ id: "1" }, (scene) => ({ id: scene.id }), { signal }),
  ).toEqualTypeOf<{ id: string } | null>();
  expectTypeOf(
    await stash.findScenes((found) => ({ count: found.count }), { timeoutMs: 1_000 }),
  ).toEqualTypeOf<{ count: number }>();
  expectTypeOf(
    await stash.performerDestroy({ input: { id: "1" } }, { signal }),
  ).toEqualTypeOf<boolean>();
  expectTypeOf(
    await stash.query((query) => ({ a: query.findScenes((f) => ({ count: f.count })) }), {
      signal,
    }),
  ).toEqualTypeOf<{ a: { count: number } }>();
  expectTypeOf(await stash.request("{ version { version } }", {}, { signal })).toEqualTypeOf<
    Record<string, unknown>
  >();
  // A subscription takes a signal, but no deadline.
  // @ts-expect-error subscriptions have no timeoutMs
  stash.jobsSubscribe((status) => status.$pick("type"), { timeoutMs: 1_000 });
  for await (const update of stash.jobsSubscribe((status) => status.$pick("type"), { signal })) {
    expectTypeOf(update).toEqualTypeOf<{ type: JobStatusUpdateType }>();
  }
}

async function invalidCalls(stash: StashClient, baseFile: Fields<"BaseFile">) {
  // @ts-expect-error object fields can't be picked, they need a selection
  await stash.findScene({ id: "1" }, (scene) => scene.$pick("studio"));
  // @ts-expect-error unknown field
  await stash.findScene({ id: "1" }, (scene) => scene.$pick("titel"));
  await stash.findPerformers((result) => ({
    // @ts-expect-error unknown field
    performers: result.performers((p) => ({ n: p.nam })),
  }));
  // @ts-expect-error unknown enum value
  await stash.findPerformers({ filter: { direction: "UP" } }, (result) => ({ c: result.count }));
  // @ts-expect-error missing required argument
  await stash.performerUpdate((performer) => ({ id: performer.id }));
  // @ts-expect-error object root fields need a selection
  await stash.findScenes({});
  // @ts-expect-error object fields need a nested selection
  await stash.findScenes((result) => ({ scenes: result.scenes }));
  await stash.findGroups((result) => ({
    // @ts-expect-error nested arguments are checked
    groups: result.groups((group) => ({ count: group.scene_count({ depth: "all" }) })),
  }));
  // @ts-expect-error $on only accepts members of the union
  await stash.findFiles((result) => ({ files: result.files((f) => f.$on("Scene", (s) => s)) }));
  // @ts-expect-error mutations can't be selected in a query
  await stash.query((query) => ({ x: query.performerDestroy({ input: { id: "1" } }) }));
  // @ts-expect-error duplicate fields in $pick are rejected
  await stash.findScene({ id: "1" }, (scene) => scene.$pick("id", "id"));
  // @ts-expect-error $pick requires at least one field name
  await stash.findScene({ id: "1" }, (scene) => scene.$pick());
  // @ts-expect-error empty selections are rejected
  await stash.findScenes(() => ({}));
  // @ts-expect-error empty root selections are rejected
  await stash.query(() => ({}));
  // @ts-expect-error spreading an uncalled object field selects nothing
  // oxlint-disable-next-line typescript/no-misused-spread -- testing compile-time rejection of spread
  await stash.findPerformers((found) => ({ ...found.$pick("count"), ...found.performers }));
  // @ts-expect-error spreading a scalar field directly instead of assigning it to a key
  await stash.findPerformers((found) => ({ ...found.count }));
  // @ts-expect-error spreading a called object field instead of assigning it to a key
  await stash.findPerformers((found) => ({
    ...found.$pick("count"),
    ...found.performers((p) => p.$pick("id")),
  }));
  // @ts-expect-error spreading the callback parameter selects nothing at runtime
  await stash.version((version) => ({ ...version }));
  // @ts-expect-error aliases must be valid GraphQL identifiers
  await stash.findScenes((result) => ({ "a-b": result.count }));
  // @ts-expect-error fragments from another type cannot be spread into an unrelated selection
  await stash.findPerformers((found) => ({
    count: found.count,
    ...fileFields(baseFile),
  }));
  // @ts-expect-error Result rejects reusable callbacks whose selection is invalid
  expectTypeOf<Result<(performer: Fields<"Performer">) => { bad: typeof performer.tags }>>();
  // @ts-expect-error Result rejects callbacks without a Fields<Name> parameter
  expectTypeOf<Result<() => { id: string }>>();
}

test("compile-time checks are part of `bun check`", () => {
  expect([
    resultTypes,
    aliasTypes,
    pickTypes,
    unionTypes,
    reusableSelections,
    generatedShapes,
    perCallOptions,
    invalidCalls,
  ]).toHaveLength(8);
});
