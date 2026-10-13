import { expect, test } from "bun:test";

import { planRelease } from "./release-plan.ts";

const base = {
  latest: "v0.31.1",
  latestSchema: "aaa",
  trackedSchema: "aaa",
  current: "0.31.0",
  published: ["0.30.0", "0.31.0"],
  force: false,
};

test("does nothing when the schema is unchanged and the version is published", () => {
  expect(planRelease(base)).toEqual({
    release: false,
    schema: false,
    stash: "v0.31.1",
    version: "0.31.0",
  });
});

test("a newer Stash release that did not touch the schema is skipped", () => {
  const plan = planRelease({ ...base, latest: "v0.31.2" });
  expect(plan).toEqual({ release: false, schema: false, stash: "v0.31.2", version: "0.31.0" });
});

test("starts a new series at patch 0", () => {
  const plan = planRelease({ ...base, latest: "v0.32.0", latestSchema: "bbb" });
  expect(plan).toMatchObject({ release: true, schema: true, version: "0.32.0" });
});

test("a schema change inside a series bumps the patch", () => {
  const plan = planRelease({ ...base, latest: "v0.31.2", latestSchema: "bbb" });
  expect(plan).toMatchObject({ release: true, schema: true, version: "0.31.1" });
});

test("retries an unpublished version left by a failed run", () => {
  const plan = planRelease({ ...base, current: "0.31.1" });
  expect(plan).toMatchObject({ release: true, schema: false, version: "0.31.1" });
});

test("a forced release publishes the next patch without a schema update", () => {
  const plan = planRelease({ ...base, force: true });
  expect(plan).toMatchObject({ release: true, schema: false, version: "0.31.1" });
});

test("never goes below an existing version of the series", () => {
  const plan = planRelease({
    ...base,
    latest: "v0.31.3",
    latestSchema: "bbb",
    published: ["0.31.0", "0.31.4"],
  });
  expect(plan.version).toBe("0.31.5");
});

test("the first release moves from the placeholder version to the Stash series", () => {
  const plan = planRelease({ ...base, current: "0.1.0", published: [] });
  expect(plan).toMatchObject({ release: true, schema: false, version: "0.31.0" });
});

test("a stale package.json does not cause a duplicate release of a published series", () => {
  const plan = planRelease({ ...base, current: "0.1.0", published: ["0.0.0-stage", "0.31.0"] });
  expect(plan).toMatchObject({ release: false, schema: false });
});
