/** The first line of schema/stash.graphql records the release and the fingerprint of its schema. */
const HEADER = /^# Stash (\S+)(?: (\S+))?/;

export function schemaHeader(tag: string, fingerprint: string) {
  return `# Stash ${tag} ${fingerprint}`;
}

/** Reads what `schemaHeader` wrote; a missing header or fingerprint reads as `undefined` and "". */
export function parseSchemaHeader(source: string) {
  const [, tag, fingerprint] = HEADER.exec(source) ?? [];
  return { tag, fingerprint: fingerprint ?? "" };
}
