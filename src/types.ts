import type { Abstract, FieldArgs, Objects } from "./generated/schema.ts";
import type { RequestOptions, Subscription } from "./transport.ts";

/** A reference to an object, interface or union type. */
export interface R<Name extends keyof Objects> {
  ref: Name;
}

export type ObjectName = keyof Objects;

declare const fieldValue: unique symbol;
declare const fragmentValue: unique symbol;
declare const fieldsOf: unique symbol;

/** A selected field whose value in the result is `T`. */
export interface Field<T> {
  readonly [fieldValue]: T;
}
/** Fields selected on one member of a union or interface, see `$on`. */
export interface Fragment<T, M extends string = string> {
  readonly [fragmentValue]: T;
  readonly [fieldsOf]?: M;
}

type ForbiddenSpread = typeof fieldValue | typeof fragmentValue | typeof fieldsOf;

/** What a selection callback returns: result keys mapped to selected fields. */
export type Selection = Record<string, Field<unknown> | Fragment<unknown>> & {
  readonly [K in ForbiddenSpread]?: never;
};
type RawSelection = Record<string, unknown>;

type Digit = "0" | "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9";
type IsStartChar<C extends string> = C extends "_"
  ? true
  : Lowercase<C> extends Uppercase<C>
    ? false
    : true;
type IsNameTail<S extends string> = S extends `${infer C}${infer Rest}`
  ? C extends Digit
    ? IsNameTail<Rest>
    : IsStartChar<C> extends true
      ? IsNameTail<Rest>
      : false
  : true;
type IsGraphQLName<S extends string> = string extends S
  ? true
  : S extends `${infer C}${infer Rest}`
    ? IsStartChar<C> extends true
      ? IsNameTail<Rest>
      : false
    : false;

/**
 * The object type a field resolves to, looking through lists and nullability; `never` for a scalar.
 */
type RefName<T> =
  T extends R<infer Name> ? Name : T extends readonly (infer I)[] ? RefName<I> : never;
/** The value of a field of type `T`; `Inner` is the value of the object it refers to. */
type Wrap<T, Inner> =
  T extends R<ObjectName> ? Inner : T extends readonly (infer I)[] ? Wrap<I, Inner>[] : T;
type Value<S> = S extends Field<infer T> ? T : never;

type FragmentKey = `... on ${string}`;
type MemberOutput<S, M extends string> =
  S extends Record<`... on ${M}`, Fragment<infer T, M>> ? T : {};

/**
 * The result of selection `S` on object type `Name`. The mapped types are written inline rather
 * than as named helpers so that editors show the resulting object instead of a helper name.
 */
export type Output<Name extends ObjectName, S> = Name extends keyof Abstract
  ? Extract<keyof S, FragmentKey> extends never
    ? { [K in keyof S]: Value<S[K]> }
    : {
        [M in Abstract[Name]]: { [K in Exclude<keyof S, FragmentKey>]: Value<S[K]> } & {
          __typename: M;
        } & MemberOutput<S, M> extends infer O
          ? { [K in keyof O]: O[K] }
          : never;
      }[Abstract[Name]]
  : { [K in keyof S]: Value<S[K]> };

type ValidEntry<Name extends ObjectName, K extends string, V> = 0 extends 1 & V
  ? V
  : K extends `... on ${infer M}`
    ? Name extends keyof Abstract
      ? M extends Abstract[Name]
        ? [V] extends [Fragment<unknown, M> | undefined]
          ? V
          : `Fragment key "${K}" must come from ...$on("${M}", (f) => ...)`
        : `Fragment "... on ${M}" cannot be used on ${Name} (allowed: ${Abstract[Name]})`
      : `Inline fragments ($on) cannot be used on non-union/interface type ${Name}`
    : IsGraphQLName<K> extends false
      ? `Invalid GraphQL alias "${K}": must match /^[_A-Za-z][_0-9A-Za-z]*$/`
      : [V] extends [Field<unknown> | undefined]
        ? V
        : [V] extends [Fragment<unknown> | undefined]
          ? `Result of $on(...) cannot be assigned to "${K}"; spread it with ...$on(...)`
          : [V] extends [(...args: never[]) => unknown]
            ? `Field "${K}" requires a selection callback or arguments: ${K}((f) => ...)`
            : Field<unknown>;

type ValidSelection<Name extends ObjectName, S> = [keyof S] extends [never]
  ? { readonly ["A selection must select at least one field"]: never }
  : Extract<keyof S, ForbiddenSpread> extends never
    ? { [K in keyof S]: ValidEntry<Name, K & string, S[K]> }
    : {
        readonly ["Only $pick(...) and $on(...) can be spread with ...; assign fields to a key"]: never;
      };

export type Select<Name extends ObjectName, S> = (
  fields: Fields<Name>,
) => S & ValidSelection<Name, S>;
type NoArgs<A> = [keyof A] extends [never] ? true : false;

type ScalarField<A, V> =
  NoArgs<A> extends true
    ? Field<V>
    : {} extends A
      ? Field<V> & ((args: A) => Field<V>)
      : (args: A) => Field<V>;

/** How a selected value arrives: as a nested field, a request or a subscription. */
type Delivery<Kind, V> = Kind extends "subscription"
  ? Subscription<V>
  : Kind extends "request"
    ? Promise<V>
    : Field<V>;

/** Per-call options; a subscription takes only a signal, since it has no deadline. */
type OptionsParam<Kind> = Kind extends "field"
  ? []
  : [options?: Kind extends "subscription" ? Pick<RequestOptions, "signal"> : RequestOptions];

type ObjectField<A, T, Name extends ObjectName, Kind = "field"> =
  NoArgs<A> extends true
    ? <S extends RawSelection>(
        select: Select<Name, S>,
        ...options: OptionsParam<Kind>
      ) => Delivery<Kind, Wrap<T, Output<Name, S>>>
    : {} extends A
      ? {
          <S extends RawSelection>(
            select: Select<Name, S>,
            ...options: OptionsParam<Kind>
          ): Delivery<Kind, Wrap<T, Output<Name, S>>>;
          <S extends RawSelection>(
            args: A | undefined,
            select: Select<Name, S>,
            ...options: OptionsParam<Kind>
          ): Delivery<Kind, Wrap<T, Output<Name, S>>>;
        }
      : <S extends RawSelection>(
          args: A,
          select: Select<Name, S>,
          ...options: OptionsParam<Kind>
        ) => Delivery<Kind, Wrap<T, Output<Name, S>>>;

/** Arguments of field `K` of object type `Name`; an empty object when it takes none. */
type ArgsOf<Name extends ObjectName, K> = Name extends keyof FieldArgs
  ? K extends keyof FieldArgs[Name]
    ? FieldArgs[Name][K]
    : {}
  : {};

/** A field of type `T` with arguments `A`: a selected value, or a method on a root field. */
type FieldType<A, T, Kind = "field"> = [RefName<T>] extends [never]
  ? Kind extends "field"
    ? ScalarField<A, Wrap<T, never>>
    : ScalarMethod<A, Wrap<T, never>, Kind>
  : ObjectField<A, T, RefName<T>, Kind>;

type FieldOf<Name extends ObjectName, K extends keyof Objects[Name]> =
  FieldType<ArgsOf<Name, K>, Objects[Name][K]> extends infer F
    ? F extends Field<unknown>
      ? F
      : F & { readonly [fieldsOf]?: Name }
    : never;

/**
 * Selects fields on member `M` of a union or interface. Spread the result into the selection;
 * the result is then narrowed by `__typename`.
 */
type On<Name extends keyof Abstract> = <
  M extends Abstract[Name] & ObjectName,
  S extends RawSelection,
>(
  type: M,
  select: Select<M, S>,
) => { [K in `... on ${M}`]: Fragment<Output<M, S>, M> };

/** Fields that can be selected by name alone: scalars without required arguments. */
type Pickable<Name extends ObjectName> = {
  [K in keyof Objects[Name]]: FieldOf<Name, K> extends Field<unknown> ? K : never;
}[keyof Objects[Name]];

type UniquePick<
  Allowed extends PropertyKey,
  Names extends readonly [Allowed, ...Allowed[]],
  Seen = never,
> = Names extends readonly [infer Head extends Allowed, ...infer Rest]
  ? [
      Head extends Seen ? `Duplicate field "${Head & string}" in $pick` : Head,
      ...(Rest extends readonly [Allowed, ...Allowed[]]
        ? UniquePick<Allowed, Rest, Seen | Head>
        : []),
    ]
  : never;

/** Selects scalar fields by name. Spread the result into a selection, or return it as is. */
type PickFields<Name extends ObjectName> = <
  const K extends readonly [Pickable<Name>, ...Pickable<Name>[]],
>(
  ...names: K & UniquePick<Pickable<Name>, K>
) => { [P in K[number]]: Field<Value<FieldOf<Name, P>>> };

/**
 * The fields of object type `Name`, passed to selection callbacks. Reading a field selects it;
 * fields with arguments are called with them, and object fields with a nested selection.
 * Don't use `...rest` on it: the object is empty at runtime, so a rest element selects nothing.
 */
export type Fields<Name extends ObjectName> = {
  readonly [K in keyof Objects[Name]]: FieldOf<Name, K>;
} & {
  /** The name of the object type. */
  readonly __typename: Field<Name extends keyof Abstract ? Abstract[Name] : Name>;
  readonly $pick: PickFields<Name>;
  /** Type-only: lets `Result` find the object type of a selection callback. */
  readonly [fieldsOf]?: Name;
} & (Name extends keyof Abstract ? { readonly $on: On<Name> } : {});

type CallbackObject<Callback> = Callback extends (
  fields: infer Input,
  ...options: never[]
) => unknown
  ? [Input] extends [{ readonly [fieldsOf]?: infer Name extends ObjectName }]
    ? Name
    : never
  : never;

/**
 * The result of a reusable selection callback:
 * `const card = (performer: Fields<"Performer">) => ({ id: performer.id })` gives
 * `Result<typeof card>`, which is `{ id: string }`. Extra parameters, such as a flag, are allowed
 * and have no share in the result.
 */
export type Result<
  Callback extends (
    fields: never,
    ...options: never[]
  ) => [CallbackObject<Callback>] extends [never]
    ? {
        readonly ["Result<typeof fn> requires the first parameter of fn to be typed as Fields<Name>"]: never;
      }
    : ValidSelection<CallbackObject<Callback>, ReturnType<Callback>>,
> = Output<CallbackObject<Callback>, ReturnType<Callback>>;

/** All root fields; mapping over `keyof Root` keeps their docs on the client methods. */
export type Root = Objects["Query"] & Objects["Mutation"] & Objects["Subscription"];
/** Every query, mutation and subscription root field. */
export type RootField = keyof Root;
/** Root fields delivered over WebSocket. */
export type SubscriptionField = keyof Objects["Subscription"];

type RootArgs = FieldArgs["Query"] & FieldArgs["Mutation"] & FieldArgs["Subscription"];
/** Arguments of a root field; an empty object when it takes none. */
export type Args<K extends RootField> = K extends keyof RootArgs ? RootArgs[K] : {};

type ScalarMethod<A, V, Kind> =
  NoArgs<A> extends true
    ? (...options: OptionsParam<Kind>) => Delivery<Kind, V>
    : {} extends A
      ? (args?: A, ...options: OptionsParam<Kind>) => Delivery<Kind, V>
      : (args: A, ...options: OptionsParam<Kind>) => Delivery<Kind, V>;

type Method<K extends RootField, Kind> = FieldType<Args<K>, Root[K], Kind>;

/** One method per root field: arguments first (when it has any), then the selection. */
export type RootMethods = {
  [K in keyof Root]: Method<K, K extends SubscriptionField ? "subscription" : "request">;
};
