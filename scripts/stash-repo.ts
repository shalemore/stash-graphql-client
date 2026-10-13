/** Reads the official Stash repository. Set GITHUB_TOKEN to avoid API rate limits. */
import { Octokit } from "@octokit/rest";

const github = new Octokit({ auth: process.env["GITHUB_TOKEN"] || undefined });
const stash = { owner: "stashapp", repo: "stash" };

export async function latestStashRelease() {
  return (await github.rest.repos.getLatestRelease(stash)).data.tag_name;
}

async function list(path: string, ref: string) {
  const { data } = await github.rest.repos.getContent({ ...stash, path, ref });
  if (!Array.isArray(data)) throw new Error(`${path} is not a directory in Stash ${ref}`);
  return data;
}

async function read(path: string, ref: string) {
  const { data } = await github.rest.repos.getContent({
    ...stash,
    path,
    ref,
    mediaType: { format: "raw" },
  });
  if (typeof data !== "string") throw new Error(`${path} is not a file in Stash ${ref}`);
  return data;
}

/**
 * Git's hash of the GraphQL schema directory at a release. It changes exactly when a schema file
 * changes, so the many Stash releases that don't touch the API share the previous release's hash.
 */
export async function schemaFingerprint(tag: string) {
  const entry = (await list("graphql", tag)).find(({ name }) => name === "schema");
  if (entry === undefined) throw new Error(`Stash ${tag} has no graphql/schema directory`);
  return entry.sha;
}

export async function schemaSources(tag: string) {
  const files = [
    "schema.graphql",
    ...(await list("graphql/schema/types", tag)).map(({ name }) => `types/${name}`),
  ];
  return Promise.all(files.map((file) => read(`graphql/schema/${file}`, tag)));
}
