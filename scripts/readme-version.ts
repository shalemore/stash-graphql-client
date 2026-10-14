/**
 * Names the Stash release the client was generated from in the README. Only the README that is
 * published to npm gets this line; the one in the repository stays as it is.
 * Usage: `bun scripts/readme-version.ts` rewrites README.md in the working tree.
 */
import { STASH_VERSION } from "../src/index.ts";

const tagline = /^A fully typed client for .*$/m;

export function withStashVersion(readme: string, version: string) {
  if (!tagline.test(readme)) throw new Error("README.md has no tagline to add the version after");
  const line = `> This version of the package is generated from the GraphQL schema of [Stash ${version}](https://github.com/stashapp/stash/releases/tag/${version}).`;
  return readme.replace(tagline, (found) => `${found}\n\n${line}`);
}

if (import.meta.main) {
  const readme = Bun.file("README.md");
  await Bun.write(readme, withStashVersion(await readme.text(), STASH_VERSION));
}
