/**
 * Downloads the GraphQL schema of a Stash release from the official repository into
 * schema/stash.graphql. Usage: `bun run schema [tag]`, defaulting to the latest release.
 */
import { buildSchema, printSchema } from "graphql";

const REPO = "stashapp/stash";

const tag = Bun.argv[2] ?? stringField(await getJson(`releases/latest`), "tag_name");
const files = await getJson(`contents/graphql/schema/types?ref=${tag}`);
if (!Array.isArray(files)) throw new Error(`No schema files found for ${tag}`);

const urls = [
  `https://raw.githubusercontent.com/${REPO}/${tag}/graphql/schema/schema.graphql`,
  ...files.map((file: unknown) => stringField(file, "download_url")),
];
const sources = await Promise.all(urls.map(async (url) => (await get(url)).text()));
// Building the schema validates it; printing normalizes the order and formatting.
const schema = printSchema(buildSchema(sources.join("\n")));

await Bun.write("schema/stash.graphql", `# Stash ${tag}\n\n${schema}\n`);
console.log(`Downloaded the schema of Stash ${tag}`);

async function get(url: string) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`GET ${url} failed: HTTP ${response.status}`);
  return response;
}

async function getJson(path: string): Promise<unknown> {
  return (await get(`https://api.github.com/repos/${REPO}/${path}`)).json();
}

function stringField(value: unknown, key: string) {
  const field = typeof value === "object" && value !== null ? Reflect.get(value, key) : undefined;
  if (typeof field !== "string") throw new Error(`Unexpected GitHub response, missing ${key}`);
  return field;
}
