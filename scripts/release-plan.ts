/**
 * Decides whether a new npm version has to be published and which one.
 *
 * The package version follows the Stash release it was generated from: Stash v0.31.x publishes
 * as 0.31.N, where N counts the releases made for that series. A release is needed when Stash
 * has a newer release than the committed schema, when the version in package.json was never
 * published (a previous run failed half way), or when forced.
 *
 * Usage: `bun scripts/release-plan.ts` prints `key=value` lines for $GITHUB_OUTPUT.
 * Set FORCE=true to publish even though nothing changed, GITHUB_TOKEN to avoid API rate limits.
 */

export interface ReleasePlan {
  /** Whether a release has to happen. */
  release: boolean;
  /** Whether the committed schema is older than the latest Stash release. */
  schema: boolean;
  /** The latest Stash release tag, e.g. v0.31.1. */
  stash: string;
  /** The npm version to publish. */
  version: string;
}

export interface ReleaseState {
  /** Tag of the latest Stash release. */
  latest: string;
  /** Tag of the Stash release the committed schema comes from. */
  tracked: string;
  /** Version in package.json. */
  current: string;
  /** Versions already on the npm registry. */
  published: readonly string[];
  force: boolean;
}

export function planRelease(state: ReleaseState): ReleasePlan {
  const { latest, tracked, current, published, force } = state;
  const schema = tracked !== latest;
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

async function getJson(url: string, headers: Record<string, string> = {}): Promise<unknown> {
  const response = await fetch(url, { headers });
  if (response.status === 404) return undefined;
  if (!response.ok) throw new Error(`GET ${url} failed: HTTP ${response.status}`);
  return response.json();
}

function field(value: unknown, key: string): unknown {
  return typeof value === "object" && value !== null ? Reflect.get(value, key) : undefined;
}

function text(value: unknown, what: string) {
  if (typeof value !== "string" || value === "") throw new Error(`Missing ${what}`);
  return value;
}

if (import.meta.main) {
  const pkg: unknown = await Bun.file("package.json").json();
  const name = text(field(pkg, "name"), "package name");
  const token = process.env["GITHUB_TOKEN"];
  const latest = text(
    field(
      await getJson(
        "https://api.github.com/repos/stashapp/stash/releases/latest",
        token === undefined || token === "" ? {} : { authorization: `Bearer ${token}` },
      ),
      "tag_name",
    ),
    "latest Stash release",
  );
  const registry = await getJson(`https://registry.npmjs.org/${name.replace("/", "%2F")}`);
  const versions = field(registry, "versions");

  const plan = planRelease({
    latest,
    tracked: (await Bun.file("schema/stash.graphql").text()).match(/^# Stash (\S+)/)?.[1] ?? "",
    current: text(field(pkg, "version"), "package version"),
    published: typeof versions === "object" && versions !== null ? Object.keys(versions) : [],
    force: process.env["FORCE"] === "true",
  });
  for (const [key, value] of Object.entries(plan)) console.log(`${key}=${value}`);
}
