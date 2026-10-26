import { getNamedType, isInputObjectType, isScalarType, type GraphQLInputType } from "graphql";

/**
 * Whether an input type can reach an Upload, so only those requests look for files. `seen` stops
 * the walk at a cycle, and a type reached twice is either already explored or on its way to an
 * Upload, which short-circuits the walk.
 */
export function hasUpload(type: GraphQLInputType, seen = new Set<string>()): boolean {
  const named = getNamedType(type);
  if (seen.has(named.name)) return false;
  seen.add(named.name);
  if (isScalarType(named)) return named.name === "Upload";
  return isInputObjectType(named)
    ? Object.values(named.getFields()).some((field) => hasUpload(field.type, seen))
    : false;
}
