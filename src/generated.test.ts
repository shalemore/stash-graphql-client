/**
 * Checks the generated runtime table against the committed schema, independently of the
 * generator, so a mismatch fails here instead of at the server.
 */
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import {
  buildSchema,
  getNamedType,
  isInputObjectType,
  isScalarType,
  type GraphQLInputType,
} from "graphql";

import { ROOTS } from "./generated/roots.ts";

const schema = buildSchema(readFileSync("schema/stash.graphql", "utf8"));

/** Whether a type can reach an Upload, mirroring the generator on purpose. */
function hasUpload(type: GraphQLInputType, seen = new Set<string>()): boolean {
  const named = getNamedType(type);
  if (seen.has(named.name)) return false;
  seen.add(named.name);
  if (isScalarType(named)) return named.name === "Upload";
  return isInputObjectType(named)
    ? Object.values(named.getFields()).some((field) => hasUpload(field.type, seen))
    : false;
}

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
