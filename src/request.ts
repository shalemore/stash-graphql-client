import { ROOTS } from "./generated/roots.ts";

export type OperationKind = "query" | "mutation" | "subscription";

export interface GraphQLRequest {
  query: string;
  variables: Record<string, unknown>;
}

type Node =
  | { kind: "field"; name: string; args: unknown; select: unknown }
  | { kind: "fragment"; type: string; select: unknown };

type Callback = (fields: unknown) => unknown;
type FieldCall = (args?: unknown, select?: unknown) => FieldCall;

/** What each selected value stands for; the values themselves are opaque to callers. */
const nodes = new WeakMap<object, Node>();

/**
 * The fields of any object type: reading `fields.name` selects that field, and calling it adds
 * arguments and a nested selection. It needs no schema, because the types already check usage.
 */
export const fields: unknown = new Proxy(
  {},
  { get: (_, key) => (typeof key !== "string" ? undefined : key === "$on" ? on : field(key)) },
);

/** Selects a field; also called by the client for root fields. */
export function field(name: string, args?: unknown, select?: unknown): FieldCall {
  const call = (first?: unknown, second?: unknown) =>
    isCallback(first)
      ? field(name, undefined, first(fields))
      : field(name, first, isCallback(second) ? second(fields) : undefined);
  nodes.set(call, { kind: "field", name, args, select });
  return call;
}

function on(type: string, select: Callback) {
  const fragment = {};
  nodes.set(fragment, { kind: "fragment", type, select: select(fields) });
  return { [`... on ${type}`]: fragment };
}

/**
 * Builds one GraphQL request from selected root fields. Root arguments become variables; with
 * several root fields they are prefixed with the result key so they can't collide. `upload`
 * tells whether the variables may contain files.
 */
export function buildRequest(kind: OperationKind, select: unknown) {
  const definitions: string[] = [];
  const variables: Record<string, unknown> = {};
  let upload = false;
  const selected = entries(select);
  const roots = selected.map(([key, value]) => {
    const node = fieldNode(key, value);
    const root = ROOTS[node.name];
    if (root?.[0] !== kind) throw new Error(`${node.name} is not a ${kind} field`);
    const [, types, files] = root;
    upload ||= files === true;
    const calls: string[] = [];
    for (const [name, argument] of entries(node.args ?? {})) {
      // undefined means "not passed"; null is a meaningful value and is sent as is.
      if (argument === undefined) continue;
      const type = types[name];
      if (type === undefined) throw new Error(`Unknown argument ${name} on ${node.name}`);
      const variable = selected.length === 1 ? name : `${key}_${name}`;
      definitions.push(`$${variable}:${type}`);
      calls.push(`${name}:$${variable}`);
      variables[variable] = argument;
    }
    return selectField(key, node, calls);
  });
  if (roots.length === 0) throw new Error("An operation must select at least one field");
  if (kind === "subscription" && roots.length > 1) {
    throw new Error("A subscription must have exactly one root field");
  }
  const header = definitions.length > 0 ? `(${definitions.join(",")})` : "";
  const request: GraphQLRequest = { query: `${kind}${header}{${roots.join(" ")}}`, variables };
  return { request, upload };
}

function selectionSet(select: unknown): string {
  if (select === undefined) return "";
  const parts: string[] = [];
  for (const [key, value] of entries(select)) {
    const node = isObject(value) ? nodes.get(value) : undefined;
    if (node?.kind === "fragment") {
      // __typename is needed to tell union members apart.
      if (!parts.includes("__typename")) parts.push("__typename");
      parts.push(`... on ${graphqlName(node.type)}${selectionSet(node.select)}`);
    } else {
      const selected = fieldNode(key, value);
      parts.push(selectField(key, selected, literals(selected.args)));
    }
  }
  if (parts.length === 0) throw new Error("A selection must select at least one field");
  return `{${parts.join(" ")}}`;
}

function selectField(key: string, node: Node & { kind: "field" }, args: string[]) {
  const alias = key === node.name ? "" : `${graphqlName(key)}:`;
  const call = args.length > 0 ? `(${args.join(",")})` : "";
  return `${alias}${graphqlName(node.name)}${call}${selectionSet(node.select)}`;
}

/** Nested arguments are scalars (checked by the generator), so JSON is valid GraphQL syntax. */
function literals(args: unknown) {
  return entries(args ?? {})
    .filter(([, argument]) => argument !== undefined)
    .map(([key, argument]) => `${graphqlName(key)}:${literal(argument)}`);
}

function literal(value: unknown): string {
  return Array.isArray(value) ? `[${value.map(literal).join(",")}]` : JSON.stringify(value);
}

function fieldNode(key: string, value: unknown) {
  const node = isObject(value) ? nodes.get(value) : undefined;
  if (node?.kind !== "field") throw new Error(`${key} is not a selected field`);
  return node;
}

/** Keys end up in the document, so only GraphQL names are allowed. */
function graphqlName(value: string) {
  if (!/^[_A-Za-z][_0-9A-Za-z]*$/.test(value)) throw new Error(`Invalid GraphQL name: ${value}`);
  return value;
}

function entries(value: unknown): [string, unknown][] {
  if (!isObject(value)) throw new Error("A selection must be an object");
  return Object.entries(value);
}

function isObject(value: unknown): value is object {
  return (typeof value === "object" && value !== null) || typeof value === "function";
}

function isCallback(value: unknown): value is Callback {
  return typeof value === "function";
}
