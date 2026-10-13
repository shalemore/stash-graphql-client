import { expect, test } from "bun:test";

import { createRunner, findPerformers, findScenes, performerDestroy } from "./operations.ts";

function fakeRunner(data: unknown) {
  const bodies: unknown[] = [];
  const stash = createRunner({
    endpoint: "http://stash.test/graphql",
    fetch: async (_url, init) => {
      bodies.push(typeof init.body === "string" ? JSON.parse(init.body) : init.body);
      return Response.json({ data });
    },
  });
  return { stash, bodies };
}

test("runs standalone operations without the client method table", async () => {
  const { stash, bodies } = fakeRunner({ findPerformers: { count: 2, performers: [] } });
  const result = await stash.run(findPerformers({ filter: { per_page: 1 } }, { count: true }));
  const count: number = result.count;
  expect(count).toBe(2);
  expect(bodies).toEqual([
    {
      query: "query($filter:FindFilterType){findPerformers(filter:$filter){count}}",
      variables: { filter: { per_page: 1 } },
    },
  ]);
});

test("batches standalone operations", async () => {
  const { stash } = fakeRunner({ performers: { count: 1 }, scenes: { count: 2 } });
  const result = await stash.batch({
    performers: findPerformers(undefined, { count: true }),
    scenes: findScenes(undefined, { count: true }),
  });
  expect(result.performers.count + result.scenes.count).toBe(3);
});

test("scalar root fields take no selection", async () => {
  const { stash } = fakeRunner({ performerDestroy: true });
  const deleted: boolean = await stash.run(performerDestroy({ input: { id: "1" } }));
  expect(deleted).toBe(true);
});
