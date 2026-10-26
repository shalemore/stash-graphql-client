/**
 * Generates src/generated from schema/stash.graphql:
 * - schema.ts: enums, input types and output type descriptions, with the official docs (types only);
 * - roots.ts: kind and argument types of every root field, used by `createStash`.
 */
import {
  buildSchema,
  getNamedType,
  type GraphQLArgument,
  type GraphQLField,
  type GraphQLInputField,
  type GraphQLInputType,
  type GraphQLOutputType,
  isEnumType,
  isInputObjectType,
  isInterfaceType,
  isListType,
  isNonNullType,
  isObjectType,
  isScalarType,
  isUnionType,
} from "graphql";

import { parseSchemaHeader } from "./schema-header.ts";
import { hasUpload } from "./schema-upload.ts";

/** A root field with the same name as a client method would be shadowed. */
const CLIENT_METHODS = new Set(["query", "mutation", "request"]);

/** JSON shape of Stash scalars. */
const SCALARS: Record<string, string> = {
  ID: "string",
  String: "string",
  Int: "number",
  Float: "number",
  Boolean: "boolean",
  Int64: "number",
  Time: "string",
  Timestamp: "string",
  Map: "Record<string, unknown>",
  BoolMap: "Record<string, boolean>",
  PluginConfigMap: "Record<string, Record<string, unknown>>",
  Any: "unknown",
  Upload: "Blob",
};

const source = await Bun.file("schema/stash.graphql").text();
const { tag: version = "unknown" } = parseSchemaHeader(source);
const schema = buildSchema(source);
const ROOT_TYPES = [
  ["query", schema.getQueryType()],
  ["mutation", schema.getMutationType()],
  ["subscription", schema.getSubscriptionType()],
] as const;

function scalar(name: string) {
  const type = SCALARS[name];
  if (type === undefined) throw new Error(`Unknown scalar ${name}, add it to SCALARS`);
  return type;
}

/** JSDoc from the schema description and deprecation reason. */
function doc(
  item: { description?: string | null | undefined; deprecationReason?: string | null | undefined },
  indent: string,
) {
  const lines = (item.description ?? "").split("\n").filter((line) => line.trim() !== "");
  if (item.deprecationReason !== null && item.deprecationReason !== undefined) {
    lines.push(`@deprecated ${item.deprecationReason}`);
  }
  if (lines.length === 0) return "";
  const body = lines.map((line) => line.replaceAll("*/", "*\\/"));
  return body.length === 1
    ? `${indent}/** ${body[0]} */\n`
    : `${indent}/**\n${body.map((line) => `${indent} * ${line}`).join("\n")}\n${indent} */\n`;
}

function input(type: GraphQLInputType): string {
  if (isNonNullType(type)) return input(type.ofType);
  if (isListType(type)) {
    const item = input(type.ofType);
    return isNonNullType(type.ofType) || item === "unknown"
      ? `Array<${item}>`
      : `Array<${item} | null>`;
  }
  return isScalarType(type) ? scalar(type.name) : type.name;
}

/** Optional inputs also accept undefined, so callers can spread partial objects. */
function inputField(value: GraphQLInputField | GraphQLArgument, indent: string) {
  const type = input(value.type);
  const declaration = isNonNullType(value.type)
    ? `${value.name}: ${type}`
    : `${value.name}?: ${type === "unknown" ? type : `${type} | null | undefined`}`;
  return `${doc(value, indent)}${indent}${declaration};`;
}

function output(type: GraphQLOutputType, nullable = true): string {
  if (isNonNullType(type)) return output(type.ofType, false);
  const inner = isListType(type)
    ? `Array<${output(type.ofType)}>`
    : isScalarType(type)
      ? scalar(type.name)
      : isEnumType(type)
        ? type.name
        : `R<"${type.name}">`;
  return nullable && inner !== "unknown" ? `${inner} | null` : inner;
}

function args(list: readonly GraphQLArgument[], indent: string) {
  if (list.length === 0) return "{}";
  return `{\n${list.map((arg) => inputField(arg, `${indent}  `)).join("\n")}\n${indent}}`;
}

function field(value: GraphQLField<unknown, unknown>) {
  return `${doc(value, "    ")}    ${value.name}: ${output(value.type)};`;
}

/** The field in `FieldArgs`, or nothing when it takes no arguments. */
function fieldArgs(value: GraphQLField<unknown, unknown>): string[] {
  return value.args.length === 0
    ? []
    : [`${doc(value, "    ")}    ${value.name}: ${args(value.args, "    ")};`];
}

const declarations: string[] = [];
const objects: string[] = [];
const argumentObjects: string[] = [];
const argumentTypes = new Set<string>();
const abstracts: string[] = [];
for (const type of Object.values(schema.getTypeMap())) {
  if (type.name.startsWith("__")) continue;
  if (isEnumType(type)) {
    const values = type.getValues().map((value) => JSON.stringify(value.name));
    declarations.push(`${doc(type, "")}export type ${type.name} = ${values.join(" | ")};`);
  } else if (isInputObjectType(type)) {
    const fields = Object.values(type.getFields()).map((value) => inputField(value, "  "));
    declarations.push(`${doc(type, "")}export interface ${type.name} {\n${fields.join("\n")}\n}`);
  } else if (isObjectType(type) || isInterfaceType(type)) {
    const fields = Object.values(type.getFields());
    objects.push(`${doc(type, "  ")}  ${type.name}: {\n${fields.map(field).join("\n")}\n  };`);
    const withArgs = fields.flatMap(fieldArgs);
    if (withArgs.length > 0) {
      argumentTypes.add(type.name);
      argumentObjects.push(`${doc(type, "  ")}  ${type.name}: {\n${withArgs.join("\n")}\n  };`);
    }
    // Nested arguments are written as literals, which is only safe for scalars.
    if (!ROOT_TYPES.some(([, root]) => root === type)) {
      for (const value of fields) {
        for (const arg of value.args) {
          if (!isScalarType(getNamedType(arg.type))) {
            throw new Error(
              `Unsupported non-scalar argument ${type.name}.${value.name}(${arg.name})`,
            );
          }
        }
      }
    }
  } else if (isUnionType(type)) {
    objects.push(`${doc(type, "  ")}  ${type.name}: {};`);
  }
  if (isUnionType(type) || isInterfaceType(type)) {
    const members = schema.getPossibleTypes(type).map((member) => JSON.stringify(member.name));
    abstracts.push(`  ${type.name}: ${members.join(" | ")};`);
  }
}

const roots: Record<string, [string, Record<string, string>, true?]> = {};
for (const [kind, type] of ROOT_TYPES) {
  for (const value of Object.values(type?.getFields() ?? {})) {
    if (CLIENT_METHODS.has(value.name) || value.name in roots) {
      throw new Error(`Root field ${value.name} clashes with a client method`);
    }
    const types = Object.fromEntries(value.args.map((arg) => [arg.name, String(arg.type)]));
    const upload = value.args.some((arg) => hasUpload(arg.type));
    roots[value.name] = upload ? [kind, types, true] : [kind, types];
  }
}

const header = `// Generated by scripts/generate.ts from the schema of Stash ${version}. Do not edit.\n`;
// `Args` looks up root fields in all three root types, so those entries always exist.
for (const [, root] of ROOT_TYPES) {
  if (root && !argumentTypes.has(root.name)) {
    argumentObjects.push(`  ${root.name}: {};`);
  }
}
await Bun.write(
  "src/generated/schema.ts",
  `${header}import type { R } from "../types.ts";\n\n` +
    `/** The Stash release this client was generated from. */\n` +
    `export type StashVersion = ${JSON.stringify(version)};\n\n` +
    `${declarations.join("\n\n")}\n\n` +
    `export interface Objects {\n${objects.join("\n")}\n}\n\n` +
    `/** Arguments of the fields that take any, grouped by object type. */\n` +
    `export interface FieldArgs {\n${argumentObjects.join("\n")}\n}\n\n` +
    `export interface Abstract {\n${abstracts.join("\n")}\n}\n`,
);
await Bun.write(
  "src/generated/roots.ts",
  `${header}export const STASH_VERSION = ${JSON.stringify(version)};\n\n` +
    `export const ROOTS: Record<string, ["query" | "mutation" | "subscription", Record<string, string>, true?]> = ${JSON.stringify(roots)};\n`,
);
console.log(`Generated ${Object.keys(roots).length} root fields from Stash ${version}`);
