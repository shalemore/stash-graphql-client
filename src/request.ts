/** What the runtime needs to know about a root field call. */
export interface RawOperation {
  field: string;
  kind: "query" | "mutation" | "subscription";
  types: Readonly<Record<string, string>>;
  args: object | undefined;
  select: unknown;
}

export interface GraphQLRequest {
  query: string;
  variables: Record<string, unknown>;
}

/**
 * Builds one GraphQL request from root field calls. Aliased calls get prefixed variables so
 * arguments with the same name don't collide. Queries and mutations can't be mixed.
 */
export function buildRequest(
  operations: ReadonlyArray<[alias: string | undefined, RawOperation]>,
): GraphQLRequest {
  const kinds = new Set<string>();
  const definitions: string[] = [];
  const fields: string[] = [];
  const variables: Record<string, unknown> = {};
  for (const [alias, { field, kind, types, args = {}, select }] of operations) {
    kinds.add(kind);
    const calls: string[] = [];
    for (const [name, value] of Object.entries(args)) {
      // undefined means "not passed"; null is a meaningful value and is sent as is.
      if (value === undefined) continue;
      const type = types[name];
      if (type === undefined) throw new Error(`Unknown argument ${name} on ${field}`);
      const variable = alias === undefined ? name : `${alias}_${name}`;
      definitions.push(`$${variable}:${type}`);
      calls.push(`${name}:$${variable}`);
      variables[variable] = value;
    }
    const call = calls.length > 0 ? `(${calls.join(",")})` : "";
    fields.push(`${alias === undefined ? "" : `${alias}:`}${field}${call}${selectionSet(select)}`);
  }
  if (kinds.size > 1) throw new Error("Different operation kinds cannot be sent in one request");
  if (kinds.has("subscription") && operations.length > 1) {
    throw new Error("A subscription must have exactly one root field");
  }
  const [kind = "query"] = kinds;
  const header = definitions.length > 0 ? `(${definitions.join(",")})` : "";
  return { query: `${kind}${header}{${fields.join(" ")}}`, variables };
}

function selectionSet(select: unknown): string {
  if (!isObject(select)) return "";
  const parts: string[] = [];
  for (const [key, value] of Object.entries(select)) {
    if (key === "$args" || value === undefined || value === false) continue;
    if (key === "$on") {
      // __typename is needed to tell union members apart.
      if (!parts.includes("__typename")) parts.push("__typename");
      for (const [type, sub] of Object.entries(isObject(value) ? value : {})) {
        parts.push(`... on ${type}${selectionSet(sub)}`);
      }
    } else if (key === "$as") {
      for (const [alias, entry] of Object.entries(isObject(value) ? value : {})) {
        const fields = Object.entries(isObject(entry) ? entry : {});
        if (fields.length !== 1) throw new Error(`Alias ${alias} must select exactly one field`);
        for (const [field, sub] of fields) parts.push(selectField(field, sub, alias));
      }
    } else if (key !== "__typename" || !parts.includes(key)) {
      parts.push(selectField(key, value));
    }
  }
  // A leaf that only carries $args has no sub-selection.
  return parts.length > 0 ? `{${parts.join(" ")}}` : "";
}

function selectField(field: string, select: unknown, alias?: string) {
  const args = isObject(select) && isObject(select["$args"]) ? select["$args"] : {};
  const literals = Object.entries(args)
    .filter(([, argument]) => argument !== undefined)
    .map(([name, argument]) => `${name}:${literal(argument)}`);
  const call = literals.length > 0 ? `(${literals.join(",")})` : "";
  return `${alias === undefined ? "" : `${alias}:`}${field}${call}${selectionSet(select)}`;
}

/** Nested arguments are scalars (checked by the generator), so JSON is valid GraphQL syntax. */
function literal(value: unknown): string {
  return Array.isArray(value) ? `[${value.map(literal).join(",")}]` : JSON.stringify(value);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
