import { expect, test } from "bun:test";

import { createStash, operation } from "./client.ts";
import { StashError } from "./runner.ts";
import type { Result, Selection } from "./types.ts";

function fakeStash(body: unknown, status = 200) {
  const requests: Array<{ url: string; init: RequestInit }> = [];
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

test("calls a root field and returns its data", async () => {
  const { stash, requests } = fakeStash({
    data: {
      findPerformers: { count: 1, performers: [{ id: "1", name: "A", rating100: null }] },
    },
  });
  const result = await stash.findPerformers(
    { filter: { per_page: 1 } },
    { count: true, performers: { id: true, name: true, rating100: true } },
  );

  const name: string | undefined = result.performers[0]?.name;
  const rating: number | null | undefined = result.performers[0]?.rating100;
  // @ts-expect-error not selected
  void result.performers[0]?.gender;
  expect([name, rating, result.count]).toEqual(["A", null, 1]);

  const [request] = requests;
  expect(request?.url).toBe("http://stash.test/graphql");
  expect(request?.init.redirect).toBe("error");
  expect(request?.init.headers).toMatchObject({
    ApiKey: "secret",
    "X-Extra": "1",
  });
});

test("throws StashError for GraphQL errors and HTTP failures", async () => {
  const graphqlError = fakeStash({ errors: [{ message: "boom" }], data: null });
  const failure = graphqlError.stash.findScenes(undefined, { count: true });
  expect(failure).rejects.toThrow(StashError);
  expect(failure).rejects.toThrow("boom");

  const httpError = fakeStash("unauthorized", 401);
  expect(httpError.stash.findScenes(undefined, { count: true })).rejects.toMatchObject({
    status: 401,
  });
});

test("returns batched results by alias", async () => {
  const { stash } = fakeStash({ data: { performers: { count: 2 }, scenes: { count: 3 } } });
  const counts = await stash.batch({
    performers: operation("findPerformers", undefined, { count: true }),
    scenes: operation("findScenes", undefined, { count: true }),
  });
  const total: number = counts.performers.count + counts.scenes.count;
  expect(total).toBe(5);
});

test("narrows unions and types reusable selections", async () => {
  const fileSelection = {
    id: true,
    visual_files: { $on: { ImageFile: { path: true, width: true } } },
  } as const satisfies Selection<"Image">;
  type ImageWithFiles = Result<"Image", typeof fileSelection>;

  const { stash } = fakeStash({
    data: {
      findImage: { id: "1", visual_files: [{ __typename: "ImageFile", path: "/a", width: 9 }] },
    },
  });
  const image: ImageWithFiles | null = await stash.findImage({ id: "1" }, fileSelection);
  for (const file of image?.visual_files ?? []) {
    if (file.__typename === "ImageFile") {
      const width: number = file.width;
      expect(width).toBe(9);
    } else {
      // @ts-expect-error path is not selected on VideoFile
      void file.path;
    }
  }
});

test("rejects invalid fields, arguments and enum values at compile time", () => {
  const { stash } = fakeStash({ data: {} });
  const calls = () => [
    // @ts-expect-error unknown field
    stash.findPerformers(undefined, { performers: { nam: true } }),
    // @ts-expect-error unknown enum value
    stash.findPerformers({ filter: { direction: "UP" } }, { count: true }),
    // @ts-expect-error missing required argument
    stash.performerUpdate(undefined, { id: true }),
    // @ts-expect-error object root fields need a selection
    stash.findScenes({}),
  ];
  expect(typeof calls).toBe("function");
});

test("narrows interface results and keeps shared fields on every member", async () => {
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
    files: {
      path: true,
      $on: {
        ImageFile: { width: true, height: true },
        VideoFile: { width: true, height: true, duration: true },
      },
    },
  });
  const sizes = files.map((file) => {
    const path: string = file.path;
    switch (file.__typename) {
      case "ImageFile":
        return `${path} ${file.width}x${file.height}`;
      case "VideoFile":
        return `${path} ${file.width}x${file.height} ${file.duration}s`;
      default:
        // @ts-expect-error width is only selected on images and videos
        void file.width;
        return path;
    }
  });
  expect(sizes).toEqual(["/a.jpg 800x600", "/b.mp4 1920x1080 12.5s", "/c.zip"]);
});
