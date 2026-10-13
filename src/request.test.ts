import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import { buildSchema, parse, validate } from "graphql";

import { operation } from "./client.ts";
import { buildRequest } from "./request.ts";

const schema = buildSchema(readFileSync("schema/stash.graphql", "utf8"));

function expectValid(query: string) {
  expect(validate(schema, parse(query)).map((error) => error.message)).toEqual([]);
}

test("requests only the selected fields and passes arguments as variables", () => {
  const request = buildRequest([
    [
      undefined,
      operation(
        "findPerformers",
        { filter: { per_page: 5, direction: "ASC" }, performer_filter: undefined },
        { count: true, performers: { id: true, name: true, tags: { id: true } } },
      ),
    ],
  ]);
  expect(request).toEqual({
    query:
      "query($filter:FindFilterType){findPerformers(filter:$filter){count performers{id name tags{id}}}}",
    variables: { filter: { per_page: 5, direction: "ASC" } },
  });
  expectValid(request.query);
});

test("selects union members with inline fragments and __typename", () => {
  const { query } = buildRequest([
    [
      undefined,
      operation(
        "findImage",
        { id: "1" },
        {
          id: true,
          visual_files: { $on: { ImageFile: { path: true, width: true } } },
        },
      ),
    ],
  ]);
  expect(query).toBe(
    "query($id:ID){findImage(id:$id){id visual_files{__typename ... on ImageFile{path width}}}}",
  );
  expectValid(query);
});

test("writes nested arguments as literals", () => {
  const { query } = buildRequest([
    [
      undefined,
      operation("findGroups", undefined, {
        groups: { id: true, scene_count: { $args: { depth: -1 } } },
      }),
    ],
  ]);
  expect(query).toBe("query{findGroups{groups{id scene_count(depth:-1)}}}");
  expectValid(query);
});

test("sends null arguments", () => {
  const request = buildRequest([
    [undefined, operation("findScenes", { filter: null }, { count: true })],
  ]);
  expect(request.variables).toEqual({ filter: null });
  expectValid(request.query);
});

test("builds mutations and scalar root fields", () => {
  const update = buildRequest([
    [undefined, operation("performerUpdate", { input: { id: "1", rating100: 80 } }, { id: true })],
  ]);
  expect(update.query).toBe(
    "mutation($input:PerformerUpdateInput!){performerUpdate(input:$input){id}}",
  );
  expectValid(update.query);
  const destroy = buildRequest([
    [undefined, operation("performerDestroy", { input: { id: "1" } })],
  ]);
  expect(destroy.query).toBe(
    "mutation($input:PerformerDestroyInput!){performerDestroy(input:$input)}",
  );
  expectValid(destroy.query);
});

test("aliases batched fields and prefixes their variables", () => {
  const request = buildRequest([
    ["performers", operation("findPerformers", { filter: { per_page: 0 } }, { count: true })],
    ["scenes", operation("findScenes", { filter: { per_page: 0 } }, { count: true })],
  ]);
  expect(request.query).toBe(
    "query($performers_filter:FindFilterType,$scenes_filter:FindFilterType){performers:findPerformers(filter:$performers_filter){count} scenes:findScenes(filter:$scenes_filter){count}}",
  );
  expectValid(request.query);
});

test("rejects mixing queries and mutations", () => {
  expect(() =>
    buildRequest([
      ["a", operation("findScenes", undefined, { count: true })],
      ["b", operation("performerDestroy", { input: { id: "1" } })],
    ]),
  ).toThrow("Different operation kinds cannot be sent in one request");
});

test("selects common interface fields and member-specific fields together", () => {
  const { query } = buildRequest([
    [
      undefined,
      operation("findFiles", undefined, {
        count: true,
        files: {
          path: true,
          size: true,
          $on: {
            ImageFile: { width: true, height: true },
            VideoFile: { width: true, height: true, duration: true, video_codec: true },
          },
        },
      }),
    ],
  ]);
  expect(query).toBe(
    "query{findFiles{count files{path size __typename ... on ImageFile{width height} ... on VideoFile{width height duration video_codec}}}}",
  );
  expectValid(query);
});
