import type { Abstract, Objects } from "./generated/schema.ts";

/** A field with arguments `A` and return type expression `T`. */
export interface F<A, T> {
  args: A;
  type: T;
}
/** A list of `T`. */
export interface L<T> {
  list: T;
}
/** A nullable `T`; anything not wrapped in `N` is non-null. */
export interface N<T> {
  nullable: T;
}
/** A reference to an object, interface or union type. */
export interface R<Name extends keyof Objects> {
  ref: Name;
}

export type ObjectName = keyof Objects;
type Unwrap<T> = T extends N<infer I> ? Unwrap<I> : T extends L<infer I> ? Unwrap<I> : T;
type HasRequired<A> = {} extends A ? false : true;
type Expand<T> = T extends (infer I)[]
  ? Expand<I>[]
  : T extends object
    ? { [K in keyof T]: Expand<T[K]> }
    : T;

/**
 * Fields to fetch from an object type: `true` for leaves, a nested selection for objects,
 * `$args` for field arguments and `$on` to select per member of a union or interface.
 * `$as` selects fields under another name, so the same field can be fetched with different
 * arguments: `$as: { md5: { fingerprint: { $args: { type: "md5" } } } }`.
 */
export type Selection<Name extends ObjectName> = {
  [K in keyof Objects[Name]]?: FieldSelection<Objects[Name][K]>;
} & { $as?: { [alias: string]: AliasedField<Objects[Name]> } } & {
  __typename?: true;
} & (Name extends keyof Abstract
    ? { $on?: { [M in Abstract[Name] & ObjectName]?: Selection<M> } }
    : {});

/** An alias selects exactly one field: `{ fieldName: selection }`. */
type AliasedField<Fields> = {
  [K in keyof Fields]: { [P in K]: FieldSelection<Fields[K]> };
}[keyof Fields];

type FieldSelection<Field> =
  Field extends F<infer A, infer T>
    ? Unwrap<T> extends R<infer Name>
      ? Selection<Name> & ArgumentSelection<A>
      : HasRequired<A> extends true
        ? { $args: A }
        : keyof A extends never
          ? true
          : true | { $args?: A }
    : never;
type ArgumentSelection<A> = keyof A extends never
  ? {}
  : HasRequired<A> extends true
    ? { $args: A }
    : { $args?: A };

type Output<T, S> =
  T extends N<infer I>
    ? Output<I, S> | null
    : T extends L<infer I>
      ? Output<I, S>[]
      : T extends R<infer Name>
        ? ObjectOutput<Name, S>
        : T;

type Picked<Name extends ObjectName, S> = {
  [
    K in keyof S & keyof Objects[Name] as K extends "$args" | "$on" ? never : K
  ]: Objects[Name][K] extends F<unknown, infer T> ? Output<T, S[K]> : never;
} & (S extends { $as: infer As } ? AliasOutput<Name, As> : {}) &
  (S extends { __typename: true } ? { __typename: Name } : {});

type AliasOutput<Name extends ObjectName, As> = {
  -readonly [A in keyof As]: {
    [K in keyof As[A] & keyof Objects[Name]]: Objects[Name][K] extends F<unknown, infer T>
      ? Output<T, As[A][K]>
      : never;
  }[keyof As[A] & keyof Objects[Name]];
};

type ObjectOutput<Name extends ObjectName, S> = Name extends keyof Abstract
  ? S extends { $on: infer On }
    ? {
        [M in Abstract[Name] & ObjectName]: Picked<Name, S> & {
          __typename: M;
        } & (M extends keyof On ? Picked<M, On[M]> : {});
      }[Abstract[Name] & ObjectName]
    : Picked<Name, S>
  : Picked<Name, S>;

/** The result of selecting `S` on an object type; the counterpart of a GraphQL fragment. */
export type Result<Name extends ObjectName, S extends Selection<Name>> = Expand<
  ObjectOutput<Name, S>
>;

/** All root fields; mapping over `keyof Root` keeps their docs on the client methods. */
export type Root = Objects["Query"] & Objects["Mutation"] & Objects["Subscription"];
/** Every query, mutation and subscription root field. */
export type RootField = keyof Root;
/** Root fields delivered over WebSocket. */
export type SubscriptionField = keyof Objects["Subscription"];
/** Root fields sent over HTTP. */
export type RequestField = Exclude<RootField, SubscriptionField>;
type RootType<K extends RootField> = Root[K] extends F<unknown, infer T> ? T : never;

/** Arguments of a root field. */
export type Args<K extends RootField> =
  Root[K] extends F<infer A extends object, unknown> ? A : never;

/** Allowed selection of a root field, `never` when it returns a scalar. */
export type RootSelection<K extends RootField> =
  Unwrap<RootType<K>> extends R<infer Name> ? Selection<Name> : never;

/** Root fields that return a scalar and therefore take no selection. */
export type ScalarField = {
  [K in RootField]: [RootSelection<K>] extends [never] ? K : never;
}[RootField];

/** Arguments of a root field; they can be left out when none of them is required. */
export type ArgsInput<K extends RootField> =
  HasRequired<Args<K>> extends true ? Args<K> : Args<K> | undefined;

/** Parameters of a root field call: a selection is required when the field returns an object. */
export type CallInput<K extends RootField, S> =
  Unwrap<RootType<K>> extends R<ObjectName>
    ? HasRequired<Args<K>> extends true
      ? [args: Args<K>, select: S]
      : [args: Args<K> | undefined, select: S]
    : HasRequired<Args<K>> extends true
      ? [args: Args<K>]
      : [args?: Args<K>];

/** The result of calling root field `K` with selection `S`. */
export type OperationResult<K extends RootField, S> = Expand<Output<RootType<K>, S>>;

declare const selectionType: unique symbol;

/** A described root field call, to pass to `run`, `batch` or `subscribe`. */
export interface Operation<K extends RootField = RootField, S = unknown> {
  readonly field: K;
  readonly kind: "query" | "mutation" | "subscription";
  /** GraphQL types of the arguments, used to declare variables. */
  readonly types: Readonly<Record<string, string>>;
  readonly args: object | undefined;
  readonly select: unknown;
  /** Set when the arguments may contain files, which are then sent as multipart. */
  readonly upload?: true;
  /** Type-only: carries the selection so the result can be inferred. */
  readonly [selectionType]?: S;
}

/** The result type of an operation value, e.g. `ResultOf<typeof findCount>`. */
export type ResultOf<O> = O extends Operation<infer K, infer S> ? OperationResult<K, S> : never;
