/**
 * Checks the generated runtime table against the committed schema, so a mismatch fails here instead
 * of at the server. The rule that decides which requests may carry files is shared with the
 * generator and covered by `scripts/schema-upload.test.ts`.
 */
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import { buildSchema } from "graphql";

import { hasUpload } from "../scripts/schema-upload.ts";
import { ROOTS } from "./generated/roots.ts";

const schema = buildSchema(readFileSync("schema/stash.graphql", "utf8"));

test("ROOTS matches the root fields of the committed schema", () => {
  const expected: Record<
    string,
    ["query" | "mutation" | "subscription", Record<string, string>, true?]
  > = {};
  for (const [kind, root] of [
    ["query", schema.getQueryType()],
    ["mutation", schema.getMutationType()],
    ["subscription", schema.getSubscriptionType()],
  ] as const) {
    for (const field of Object.values(root?.getFields() ?? {})) {
      const types = Object.fromEntries(field.args.map((arg) => [arg.name, String(arg.type)]));
      const files = field.args.some((arg) => hasUpload(arg.type));
      expected[field.name] = files ? [kind, types, true] : [kind, types];
    }
  }
  expect(ROOTS).toEqual(expected);
});
