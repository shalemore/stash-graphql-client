import { expect, test } from "bun:test";

import { planRelease } from "./release-plan.ts";

const base = {
  latest: "v0.31.1",
  tracked: "v0.31.1",
  current: "0.31.0",
  published: ["0.30.0", "0.31.0"],
  force: false,
};

test("does nothing when the schema is current and the version is published", () => {
  expect(planRelease(base)).toEqual({
    release: false,
    schema: false,
    stash: "v0.31.1",
    version: "0.31.0",
  });
});

test("starts a new series at patch 0", () => {
  const plan = planRelease({ ...base, latest: "v0.32.0" });
  expect(plan).toMatchObject({ release: true, schema: true, version: "0.32.0" });
});

test("a new Stash patch release bumps the patch of the series", () => {
  const plan = planRelease({ ...base, latest: "v0.31.2" });
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
  const plan = planRelease({ ...base, latest: "v0.31.3", published: ["0.31.0", "0.31.4"] });
  expect(plan.version).toBe("0.31.5");
});

test("the first release moves from the placeholder version to the Stash series", () => {
  const plan = planRelease({ ...base, current: "0.1.0", published: [] });
  expect(plan).toMatchObject({ release: true, schema: false, version: "0.31.0" });
});
