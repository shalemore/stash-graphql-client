/**
 * Compile-time tests: `bun check` verifies the types, so the functions below are never called.
 */
import { expect, expectTypeOf, test } from "bun:test";

import { type StashClient, operation } from "./client.ts";
import { findScenes, performerDestroy } from "./operations.ts";
import type { StashRunner } from "./runner.ts";
import type { OperationResult, Result, ResultOf, Selection } from "./types.ts";

async function resultTypes(stash: StashClient) {
  const found = await stash.findPerformers(undefined, {
    count: true,
    performers: { id: true, name: true, rating100: true, tags: { name: true } },
  });
  expectTypeOf(found).toEqualTypeOf<{
    count: number;
    performers: {
      id: string;
      name: string;
      rating100: number | null;
      tags: { name: string }[];
    }[];
  }>();

  // Scalar root fields take no selection.
  expectTypeOf(await stash.performerDestroy({ input: { id: "1" } })).toEqualTypeOf<boolean>();

  const totals = await stash.batch({
    scenes: operation("findScenes", undefined, { count: true }),
    images: operation("findImages", undefined, { count: true }),
  });
  expectTypeOf(totals).toEqualTypeOf<{ scenes: { count: number }; images: { count: number } }>();
}

async function unionTypes(stash: StashClient) {
  const { files } = await stash.findFiles(undefined, {
    files: {
      path: true,
      $on: {
        ImageFile: { width: true, height: true },
        VideoFile: { width: true, height: true, duration: true },
      },
    },
  });
  for (const file of files) {
    expectTypeOf(file.path).toBeString();
    if (file.__typename === "VideoFile") expectTypeOf(file.duration).toBeNumber();
    else if (file.__typename === "ImageFile") expectTypeOf(file).not.toHaveProperty("duration");
    // @ts-expect-error width is only selected on images and videos
    else void file.width;
  }
}

async function operationTypes(runner: StashRunner) {
  // Operations built with the generated builders and with operation() infer the same results.
  const built = await runner.run(findScenes(undefined, { count: true }));
  expectTypeOf(built).toEqualTypeOf<{ count: number }>();
  const generic = await runner.run(operation("findScenes", undefined, { count: true }));
  expectTypeOf(generic).toEqualTypeOf<{ count: number }>();

  expectTypeOf(await runner.run(performerDestroy({ input: { id: "1" } }))).toEqualTypeOf<boolean>();
  expectTypeOf(
    await runner.run(operation("performerDestroy", { input: { id: "1" } })),
  ).toEqualTypeOf<boolean>();
}

function reusableSelections() {
  const card = { id: true, name: true } as const satisfies Selection<"Performer">;
  expectTypeOf<Result<"Performer", typeof card>>().toEqualTypeOf<{ id: string; name: string }>();
  expectTypeOf<OperationResult<"findPerformers", { count: true }>>().toEqualTypeOf<{
    count: number;
  }>();

  const op = operation("findScenes", undefined, { count: true });
  expectTypeOf<ResultOf<typeof op>>().toEqualTypeOf<{ count: number }>();
}

async function invalidCalls(stash: StashClient) {
  // @ts-expect-error unknown field
  await stash.findPerformers(undefined, { performers: { nam: true } });
  // @ts-expect-error unknown enum value
  await stash.findPerformers({ filter: { direction: "UP" } }, { count: true });
  // @ts-expect-error missing required argument
  await stash.performerUpdate(undefined, { id: true });
  // @ts-expect-error object root fields need a selection
  await stash.findScenes({});
}

test("compile-time checks are part of `bun check`", () => {
  expect([resultTypes, unionTypes, operationTypes, reusableSelections, invalidCalls]).toHaveLength(
    5,
  );
});
