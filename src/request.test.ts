import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import { buildSchema, parse, validate } from "graphql";

import { createStash, type StashClient } from "./client.ts";
import type { GraphQLRequest } from "./request.ts";
import type { Fields } from "./types.ts";

const schema = buildSchema(readFileSync("schema/stash.graphql", "utf8"));

/** Runs `call` against a fake server and returns the request it sent, checked against the schema. */
async function sent(call: (stash: StashClient) => Promise<unknown>): Promise<GraphQLRequest> {
  let body: unknown;
  const stash = createStash({
    endpoint: "http://stash.test/graphql",
    fetch: async (_url, init) => {
      body = typeof init.body === "string" ? JSON.parse(init.body) : undefined;
      return Response.json({ data: {} });
    },
  });
  await call(stash);
  if (typeof body !== "object" || body === null || !("query" in body) || !("variables" in body)) {
    throw new Error("no JSON request was sent");
  }
  const { query, variables } = body;
  if (typeof query !== "string" || typeof variables !== "object" || variables === null) {
    throw new Error("malformed request");
  }
  expect(validate(schema, parse(query)).map((error) => error.message)).toEqual([]);
  return { query, variables: { ...variables } };
}

test("requests only the selected fields and passes root arguments as variables", async () => {
  const request = await sent((stash) =>
    stash.findPerformers(
      { filter: { per_page: 5, direction: "ASC" }, performer_filter: undefined },
      (result) => ({
        count: result.count,
        performers: result.performers((performer) => ({
          id: performer.id,
          name: performer.name,
          tags: performer.tags((tag) => ({ id: tag.id })),
        })),
      }),
    ),
  );
  expect(request).toEqual({
    query:
      "query($filter:FindFilterType){findPerformers(filter:$filter){count performers{id name tags{id}}}}",
    variables: { filter: { per_page: 5, direction: "ASC" } },
  });
});

test("$pick requests exactly the named fields", async () => {
  const picked = await sent((stash) =>
    stash.findScene({ id: "1" }, (scene) => ({
      ...scene.$pick("id", "title"),
      studio: scene.studio((studio) => studio.$pick("id", "name")),
    })),
  );
  const written = await sent((stash) =>
    stash.findScene({ id: "1" }, (scene) => ({
      id: scene.id,
      title: scene.title,
      studio: scene.studio((studio) => ({ id: studio.id, name: studio.name })),
    })),
  );
  expect(picked).toEqual(written);
  expect(picked.query).toContain("findScene(id:$id){id title studio{id name}}");
});

test("result keys that differ from the field name become aliases", async () => {
  const { query } = await sent((stash) =>
    stash.findGroups((result) => ({
      groups: result.groups((group) => ({
        id: group.id,
        rating: group.rating100,
        direct: group.scene_count({ depth: 0 }),
        all: group.scene_count({ depth: -1 }),
      })),
    })),
  );
  expect(query).toBe(
    "query{findGroups{groups{id rating:rating100 direct:scene_count(depth:0) all:scene_count(depth:-1)}}}",
  );
});

test("selects union and interface members with inline fragments and __typename", async () => {
  const { query } = await sent((stash) =>
    stash.findFiles((result) => ({
      count: result.count,
      files: result.files((file) => ({
        path: file.path,
        ...file.$on("ImageFile", (image) => ({ width: image.width })),
        ...file.$on("VideoFile", (video) => ({ duration: video.duration })),
      })),
    })),
  );
  expect(query).toBe(
    "query{findFiles{count files{path __typename ... on ImageFile{width} ... on VideoFile{duration}}}}",
  );
});

test("sends null arguments and leaves out undefined ones", async () => {
  const request = await sent((stash) =>
    stash.findScenes({ filter: null, ids: undefined }, (result) => ({ count: result.count })),
  );
  expect(request.variables).toEqual({ filter: null });
});

test("builds mutations and scalar root fields", async () => {
  const update = await sent((stash) =>
    stash.performerUpdate({ input: { id: "1", rating100: 80 } }, (performer) => ({
      id: performer.id,
    })),
  );
  expect(update.query).toBe(
    "mutation($input:PerformerUpdateInput!){performerUpdate(input:$input){id}}",
  );
  const destroy = await sent((stash) => stash.performerDestroy({ input: { id: "1" } }));
  expect(destroy.query).toBe(
    "mutation($input:PerformerDestroyInput!){performerDestroy(input:$input)}",
  );
});

test("selects several root fields in one query", async () => {
  const request = await sent((stash) =>
    stash.query((query) => ({
      scenes: query.findScenes({ filter: { per_page: 0 } }, (result) => ({ count: result.count })),
      images: query.findImages((result) => ({ count: result.count })),
      version: query.version((version) => ({ version: version.version })),
    })),
  );
  expect(request).toEqual({
    query:
      "query($scenes_filter:FindFilterType){scenes:findScenes(filter:$scenes_filter){count} images:findImages{count} version{version}}",
    variables: { scenes_filter: { per_page: 0 } },
  });
});

test("runs several mutations in one request", async () => {
  const request = await sent((stash) =>
    stash.mutation((mutation) => ({
      first: mutation.performerUpdate({ input: { id: "1", favorite: true } }, (p) => ({
        id: p.id,
      })),
      second: mutation.performerUpdate({ input: { id: "2" } }, (p) => ({ id: p.id })),
    })),
  );
  expect(request).toEqual({
    query:
      "mutation($first_input:PerformerUpdateInput!,$second_input:PerformerUpdateInput!){first:performerUpdate(input:$first_input){id} second:performerUpdate(input:$second_input){id}}",
    variables: { first_input: { id: "1", favorite: true }, second_input: { id: "2" } },
  });
});

const tagFields = (tag: Fields<"Tag">) => ({ id: tag.id, name: tag.name });

test("reusable selections are plain functions", async () => {
  const { query } = await sent((stash) =>
    stash.findTags((result) => ({
      tags: result.tags((tag) => ({ ...tagFields(tag), children: tag.children(tagFields) })),
    })),
  );
  expect(query).toBe("query{findTags{tags{id name children{id name}}}}");
});

test("destructuring and conditional spreads select fields too", async () => {
  const withTags = true;
  const { query } = await sent((stash) =>
    stash.findPerformers(({ performers }) => ({
      performers: performers(({ id, tags }) => ({
        id,
        ...(withTags ? { tags: tags(tagFields) } : {}),
      })),
    })),
  );
  expect(query).toBe("query{findPerformers{performers{id tags{id name}}}}");
});

/** The message a request was rejected with. */
const rejection = (request: Promise<unknown>) =>
  request.then(
    () => "resolved",
    (error: unknown) => (error instanceof Error ? error.message : String(error)),
  );

test("rejects invalid selections before sending", async () => {
  const stash = createStash({ endpoint: "http://stash.test/graphql" });
  // @ts-expect-error the values of a selection must be selected fields
  expect(await rejection(stash.findScenes(() => ({ count: true })))).toBe(
    "count is not a selected field",
  );
  expect(await rejection(stash.findScenes((r) => ({ "a b": r.count })))).toBe(
    "Invalid GraphQL name: a b",
  );
  expect(
    // @ts-expect-error mutations can't be sent as queries
    await rejection(stash.query((q) => ({ x: q.performerDestroy({ input: { id: "1" } }) }))),
  ).toBe("performerDestroy is not a query field");
  expect(await rejection(stash.findScenes(() => ({})))).toBe(
    "A selection must select at least one field",
  );
});
