/** Helpers for reading the official Stash repository. */

const REPO = "stashapp/stash";

export async function get(url: string) {
  const token = process.env["GITHUB_TOKEN"];
  const response = await fetch(url, {
    headers: token === undefined || token === "" ? {} : { authorization: `Bearer ${token}` },
  });
  if (!response.ok) throw new Error(`GET ${url} failed: HTTP ${response.status}`);
  return response;
}

export async function getJson(path: string): Promise<unknown> {
  return (await get(`https://api.github.com/repos/${REPO}/${path}`)).json();
}

export function stringField(value: unknown, key: string) {
  const field = typeof value === "object" && value !== null ? Reflect.get(value, key) : undefined;
  if (typeof field !== "string") throw new Error(`Unexpected GitHub response, missing ${key}`);
  return field;
}

export async function latestStashRelease() {
  return stringField(await getJson("releases/latest"), "tag_name");
}

/**
 * Git's hash of the GraphQL schema directory at a release. It changes exactly when a schema file
 * changes, so the many Stash releases that don't touch the API share the previous release's hash.
 */
export async function schemaFingerprint(tag: string) {
  const entries = await getJson(`contents/graphql?ref=${tag}`);
  const schema = Array.isArray(entries)
    ? entries.find((entry: unknown) => stringField(entry, "name") === "schema")
    : undefined;
  return stringField(schema, "sha");
}

export async function schemaSources(tag: string) {
  const files = await getJson(`contents/graphql/schema/types?ref=${tag}`);
  if (!Array.isArray(files)) throw new Error(`No schema files found for ${tag}`);
  const urls = [
    `https://raw.githubusercontent.com/${REPO}/${tag}/graphql/schema/schema.graphql`,
    ...files.map((file: unknown) => stringField(file, "download_url")),
  ];
  return Promise.all(urls.map(async (url) => (await get(url)).text()));
}
