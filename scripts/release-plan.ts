/**
 * Decides whether a new npm version has to be published and which one.
 *
 * The package version follows the Stash release it was generated from: Stash v0.31.x publishes
 * as 0.31.N, where N counts the releases made for that series. A release is needed when the
 * GraphQL schema of the latest Stash release differs from the committed one (most Stash releases
 * don't touch it), when the version in package.json was never published (a previous run failed
 * half way), or when forced.
 *
 * Usage: `bun scripts/release-plan.ts` prints `key=value` lines for $GITHUB_OUTPUT.
 * Set FORCE=true to publish even though nothing changed, GITHUB_TOKEN to avoid API rate limits.
 */
import { latestStashRelease, schemaFingerprint } from "./stash-repo.ts";

export interface ReleasePlan {
  /** Whether a release has to happen. */
  release: boolean;
  /** Whether the committed schema differs from the latest Stash release. */
  schema: boolean;
  /** The latest Stash release tag, e.g. v0.31.1. */
  stash: string;
  /** The npm version to publish. */
  version: string;
}

export interface ReleaseState {
  /** Tag of the latest Stash release. */
  latest: string;
  /** Fingerprint of the schema in the latest Stash release. */
  latestSchema: string;
  /** Fingerprint of the committed schema. */
  trackedSchema: string;
  /** Version in package.json. */
  current: string;
  /** Versions already on the npm registry. */
  published: readonly string[];
  force: boolean;
}

export function planRelease(state: ReleaseState): ReleasePlan {
  const { latest, latestSchema, trackedSchema, current, published, force } = state;
  const schema = trackedSchema !== latestSchema;
  const unpublished = !published.includes(current);
  if (!schema && !unpublished && !force) {
    return { release: false, schema, stash: latest, version: current };
  }
  const series = latest.replace(/^v/, "").split(".").slice(0, 2).join(".");
  const inSeries = (version: string) => version.startsWith(`${series}.`);
  // A failed earlier run already bumped package.json: publish that version instead of skipping it.
  if (!schema && unpublished && !force && inSeries(current)) {
    return { release: true, schema, stash: latest, version: current };
  }
  const patches = [...published, current].flatMap((version) => {
    const patch = version.slice(series.length + 1);
    return inSeries(version) && /^\d+$/.test(patch) ? [Number(patch)] : [];
  });
  return {
    release: true,
    schema,
    stash: latest,
    version: `${series}.${Math.max(-1, ...patches) + 1}`,
  };
}

function field(value: unknown, key: string): unknown {
  return typeof value === "object" && value !== null ? Reflect.get(value, key) : undefined;
}

function text(value: unknown, what: string) {
  if (typeof value !== "string" || value === "") throw new Error(`Missing ${what}`);
  return value;
}

async function getRegistryVersions(name: string) {
  const response = await fetch(`https://registry.npmjs.org/${name.replace("/", "%2F")}`);
  if (response.status === 404) return [];
  if (!response.ok) throw new Error(`npm registry failed: HTTP ${response.status}`);
  const versions = field(await response.json(), "versions");
  return typeof versions === "object" && versions !== null ? Object.keys(versions) : [];
}

if (import.meta.main) {
  const pkg: unknown = await Bun.file("package.json").json();
  const latest = await latestStashRelease();
  const header = (await Bun.file("schema/stash.graphql").text()).match(/^# Stash \S+ (\S+)/);

  const plan = planRelease({
    latest,
    latestSchema: await schemaFingerprint(latest),
    trackedSchema: header?.[1] ?? "",
    current: text(field(pkg, "version"), "package version"),
    published: await getRegistryVersions(text(field(pkg, "name"), "package name")),
    force: process.env["FORCE"] === "true",
  });
  for (const [key, value] of Object.entries(plan)) console.log(`${key}=${value}`);
}
