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
 * Set FORCE=true to publish even though nothing changed.
 */
import semver from "semver";
import { z } from "zod";

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
  const stash = latest;
  if (!schema && !unpublished && !force) return { release: false, schema, stash, version: current };

  const { major, minor } = semver.parse(latest) ?? never(`Invalid Stash release ${latest}`);
  const series = `${major}.${minor}.x`;
  if (!schema && !force) {
    // A failed earlier run already bumped package.json: publish that version instead of skipping it.
    if (semver.satisfies(current, series))
      return { release: true, schema, stash, version: current };
    // package.json is stale, but this series was already published: nothing to release.
    if (published.some((version) => semver.satisfies(version, series))) {
      return { release: false, schema, stash, version: current };
    }
  }
  const highest = semver.maxSatisfying([...published, current], series);
  const version = highest === null ? `${major}.${minor}.0` : semver.inc(highest, "patch");
  return { release: true, schema, stash, version: version ?? never(`Cannot bump ${highest}`) };
}

function never(message: string): never {
  throw new Error(message);
}

async function getPublishedVersions(name: string) {
  const response = await fetch(`https://registry.npmjs.org/${name.replace("/", "%2F")}`);
  if (response.status === 404) return [];
  if (!response.ok) throw new Error(`npm registry failed: HTTP ${response.status}`);
  const { versions } = z
    .object({ versions: z.record(z.string(), z.unknown()) })
    .parse(await response.json());
  return Object.keys(versions);
}

if (import.meta.main) {
  const pkg = z
    .object({ name: z.string(), version: z.string() })
    .parse(await Bun.file("package.json").json());
  const latest = await latestStashRelease();
  const header = (await Bun.file("schema/stash.graphql").text()).match(/^# Stash \S+ (\S+)/);

  const plan = planRelease({
    latest,
    latestSchema: await schemaFingerprint(latest),
    trackedSchema: header?.[1] ?? "",
    current: pkg.version,
    published: await getPublishedVersions(pkg.name),
    force: process.env["FORCE"] === "true",
  });
  for (const [key, value] of Object.entries(plan)) console.log(`${key}=${value}`);
}
