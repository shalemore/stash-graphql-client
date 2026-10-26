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
export interface Fragment<T> {
  readonly [fragmentValue]: T;
}
/** What a selection callback returns: result keys mapped to selected fields. */
export type Selection = Record<string, Field<unknown> | Fragment<unknown>>;

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
  S extends Record<`... on ${M}`, Fragment<infer T>> ? T : {};

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

type Select<Name extends ObjectName, S> = (fields: Fields<Name>) => S;
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
    ? <S extends Selection>(
        select: Select<Name, S>,
        ...options: OptionsParam<Kind>
      ) => Delivery<Kind, Wrap<T, Output<Name, S>>>
    : {} extends A
      ? {
          <S extends Selection>(
            select: Select<Name, S>,
            ...options: OptionsParam<Kind>
          ): Delivery<Kind, Wrap<T, Output<Name, S>>>;
          <S extends Selection>(
            args: A | undefined,
            select: Select<Name, S>,
            ...options: OptionsParam<Kind>
          ): Delivery<Kind, Wrap<T, Output<Name, S>>>;
        }
      : <S extends Selection>(
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

type FieldOf<Name extends ObjectName, K extends keyof Objects[Name]> = FieldType<
  ArgsOf<Name, K>,
  Objects[Name][K]
>;

/**
 * Selects fields on member `M` of a union or interface. Spread the result into the selection;
 * the result is then narrowed by `__typename`.
 */
type On<Name extends keyof Abstract> = <M extends Abstract[Name] & ObjectName, S extends Selection>(
  type: M,
  select: Select<M, S>,
) => { [K in `... on ${M}`]: Fragment<Output<M, S>> };

/** Fields that can be selected by name alone: scalars without required arguments. */
type Pickable<Name extends ObjectName> = {
  [K in keyof Objects[Name]]: FieldOf<Name, K> extends Field<unknown> ? K : never;
}[keyof Objects[Name]];

/** Selects scalar fields by name. Spread the result into a selection, or return it as is. */
type PickFields<Name extends ObjectName> = <K extends Pickable<Name>>(
  ...names: K[]
) => { [P in K]: Field<Value<FieldOf<Name, P>>> };

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

/**
 * The result of a reusable selection callback:
 * `const card = (performer: Fields<"Performer">) => ({ id: performer.id })` gives
 * `Result<typeof card>`, which is `{ id: string }`. Extra parameters, such as a flag, are allowed
 * and have no share in the result.
 */
export type Result<Callback> = Callback extends (
  fields: infer Input,
  ...options: never[]
) => infer S
  ? Input extends { readonly [fieldsOf]?: infer Name extends ObjectName }
    ? Output<Name, S>
    : never
  : never;

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
