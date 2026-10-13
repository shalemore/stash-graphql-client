import { expect, test } from "bun:test";

import { createStash, operation } from "./client.ts";
import { StashError } from "./runner.ts";

function fakeStash(body: unknown, status = 200) {
  const requests: { url: string; init: RequestInit }[] = [];
  const stash = createStash({
    endpoint: "http://stash.test/graphql",
    apiKey: "secret",
    headers: { "X-Extra": "1" },
    fetch: async (url, init) => {
      requests.push({ url, init });
      return Response.json(body, { status });
    },
  });
  return { stash, requests };
}

test("calls a root field with the API key and returns its data", async () => {
  const { stash, requests } = fakeStash({
    data: { findPerformers: { count: 1, performers: [{ id: "1", name: "A", rating100: null }] } },
  });
  const result = await stash.findPerformers(
    { filter: { per_page: 1 } },
    { count: true, performers: { id: true, name: true, rating100: true } },
  );

  expect(result).toEqual({ count: 1, performers: [{ id: "1", name: "A", rating100: null }] });
  expect(requests).toHaveLength(1);
  expect(requests[0]).toMatchObject({
    url: "http://stash.test/graphql",
    init: { redirect: "error", headers: { ApiKey: "secret", "X-Extra": "1" } },
  });
});

test("throws StashError for GraphQL errors and HTTP failures", async () => {
  const graphqlError = fakeStash({ errors: [{ message: "boom" }], data: null });
  const failure = graphqlError.stash.findScenes(undefined, { count: true });
  expect(failure).rejects.toThrow(StashError);
  expect(failure).rejects.toThrow("boom");

  const httpError = fakeStash("unauthorized", 401);
  const error = await httpError.stash
    .findScenes(undefined, { count: true })
    .catch((e: unknown) => e);
  expect(error).toMatchObject({ status: 401 });
});

test("returns batched results by alias", async () => {
  const { stash } = fakeStash({ data: { performers: { count: 2 }, scenes: { count: 3 } } });
  const counts = await stash.batch({
    performers: operation("findPerformers", undefined, { count: true }),
    scenes: operation("findScenes", undefined, { count: true }),
  });
  expect(counts).toEqual({ performers: { count: 2 }, scenes: { count: 3 } });
});

test("returns union members as the server sent them", async () => {
  const { stash } = fakeStash({
    data: {
      findFiles: {
        files: [
          { __typename: "ImageFile", path: "/a.jpg", width: 800, height: 600 },
          { __typename: "VideoFile", path: "/b.mp4", width: 1920, height: 1080, duration: 12.5 },
          { __typename: "GalleryFile", path: "/c.zip" },
        ],
      },
    },
  });
  const { files } = await stash.findFiles(undefined, {
    files: { path: true, $on: { ImageFile: { width: true }, VideoFile: { duration: true } } },
  });
  expect(files.map((file) => file.__typename)).toEqual(["ImageFile", "VideoFile", "GalleryFile"]);
});
