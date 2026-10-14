import { expect, test } from "bun:test";

import { planUpdate } from "./update-plan.ts";

const base = {
  latest: "v0.31.1",
  latestSchema: "aaa",
  trackedSchema: "aaa",
  current: "0.31.0",
};

test("does nothing when the schema is unchanged", () => {
  expect(planUpdate(base)).toEqual({ update: false, stash: "v0.31.1", version: "0.31.0" });
});

test("a newer Stash release that did not touch the schema is skipped", () => {
  const plan = planUpdate({ ...base, latest: "v0.31.2" });
  expect(plan).toEqual({ update: false, stash: "v0.31.2", version: "0.31.0" });
});

test("a schema change inside a series bumps the patch", () => {
  const plan = planUpdate({ ...base, latest: "v0.31.2", latestSchema: "bbb" });
  expect(plan).toEqual({ update: true, stash: "v0.31.2", version: "0.31.1" });
});

test("a schema change in a new series starts at patch 0", () => {
  const plan = planUpdate({ ...base, latest: "v0.32.0", latestSchema: "bbb" });
  expect(plan).toEqual({ update: true, stash: "v0.32.0", version: "0.32.0" });
});

test("moves from the placeholder version to the Stash series", () => {
  const plan = planUpdate({ ...base, current: "0.1.0", latestSchema: "bbb" });
  expect(plan.version).toBe("0.31.0");
});
