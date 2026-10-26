/**
 * Downloads the GraphQL schema of a Stash release from the official repository into
 * schema/stash.graphql. Usage: `bun run schema [tag]`, defaulting to the latest release.
 * The first line records the release and the fingerprint used to detect schema changes.
 */
import { buildSchema, printSchema } from "graphql";

import { schemaHeader } from "./schema-header.ts";
import { latestStashRelease, schemaFingerprint, schemaSources } from "./stash-repo.ts";

const tag = Bun.argv[2] ?? (await latestStashRelease());
const fingerprint = await schemaFingerprint(tag);
// Building the schema validates it; printing normalizes the order and formatting.
const schema = printSchema(buildSchema((await schemaSources(tag)).join("\n")));

await Bun.write("schema/stash.graphql", `${schemaHeader(tag, fingerprint)}\n\n${schema}\n`);
console.log(`Downloaded the schema of Stash ${tag} (${fingerprint.slice(0, 10)})`);
