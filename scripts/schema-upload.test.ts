import { expect, test } from "bun:test";
import { buildSchema, type GraphQLInputType } from "graphql";

import { hasUpload } from "./schema-upload.ts";

const schema = buildSchema(`
  scalar Upload
  input WithFile {
    file: Upload
  }
  input Nested {
    inner: WithFile
  }
  input Files {
    list: [WithFile!]
  }
  input Plain {
    name: String
  }
  input Cycle {
    back: Cycle
  }
  input Cyclic {
    plain: Plain
    cycle: Cycle
    nested: Nested
  }
  type Query {
    direct(file: Upload): String
    nested(value: Nested): String
    files(value: Files): String
    plain(value: Plain): String
    cycle(value: Cycle): String
    cyclic(value: Cyclic): String
  }
`);

/** The type of the first argument of a query field of the schema above. */
function argument(field: string): GraphQLInputType {
  const type = schema.getQueryType()?.getFields()[field]?.args[0]?.type;
  if (type === undefined) throw new Error(`no first argument on ${field}`);
  return type;
}

test("finds an Upload of the argument and through nested or listed inputs", () => {
  expect(hasUpload(argument("direct"))).toBe(true);
  expect(hasUpload(argument("nested"))).toBe(true);
  expect(hasUpload(argument("files"))).toBe(true);
});

test("an input without an Upload anywhere stays without files", () => {
  expect(hasUpload(argument("plain"))).toBe(false);
});

test("stops at cycles instead of recursing forever", () => {
  expect(hasUpload(argument("cycle"))).toBe(false);
  // The nested input is found after the cycle, so a visited input must not end the walk.
  expect(hasUpload(argument("cyclic"))).toBe(true);
});
