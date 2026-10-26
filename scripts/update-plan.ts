/**
 * Decides whether the committed schema is behind the latest Stash release, and which package
 * version the update gets. Most Stash releases don't touch the GraphQL schema, so only a change
 * of the schema counts. Stash v0.31.x publishes as 0.31.N, where N counts the updates of that series.
 *
 * Usage: `bun scripts/update-plan.ts` prints `key=value` lines for $GITHUB_OUTPUT.
 */
import semver from "semver";

import { parseSchemaHeader } from "./schema-header.ts";
import { latestStashRelease, schemaFingerprint } from "./stash-repo.ts";

export interface UpdateState {
  /** Tag of the latest Stash release. */
  latest: string;
  /** Fingerprint of the schema in the latest Stash release. */
  latestSchema: string;
  /** Fingerprint of the committed schema. */
  trackedSchema: string;
  /** Version in package.json. */
  current: string;
}

export interface UpdatePlan {
  /** Whether the committed schema differs from the latest Stash release. */
  update: boolean;
  /** The latest Stash release tag, e.g. v0.31.1. */
  stash: string;
  /** The package version after the update. */
  version: string;
}

export function planUpdate({ latest, latestSchema, trackedSchema, current }: UpdateState) {
  const stash = latest;
  const update = trackedSchema !== latestSchema;
  if (!update) return { update, stash, version: current };

  const { major, minor } = semver.parse(latest) ?? never(`Invalid Stash release ${latest}`);
  const published = semver.parse(current) ?? never(`Invalid version ${current}`);
  const version =
    published.major === major && published.minor === minor
      ? semver.inc(published, "patch")
      : `${major}.${minor}.0`;
  return { update, stash, version: version ?? never(`Cannot bump ${current}`) };
}

function never(message: string): never {
  throw new Error(message);
}

if (import.meta.main) {
  const manifest: unknown = await Bun.file("package.json").json();
  const version =
    typeof manifest === "object" &&
    manifest !== null &&
    "version" in manifest &&
    typeof manifest.version === "string"
      ? manifest.version
      : never("package.json has no version");
  const latest = await latestStashRelease();
  const { fingerprint } = parseSchemaHeader(await Bun.file("schema/stash.graphql").text());

  const plan = planUpdate({
    latest,
    latestSchema: await schemaFingerprint(latest),
    trackedSchema: fingerprint,
    current: version,
  });
  for (const [key, value] of Object.entries(plan)) console.log(`${key}=${value}`);
}
