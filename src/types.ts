import type { Abstract, Objects } from "./generated/schema.ts";
import type { Subscription } from "./transport.ts";

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

type Unwrap<T> = T extends N<infer I> ? Unwrap<I> : T extends L<infer I> ? Unwrap<I> : T;
/** The value of a field of type `T`; `Inner` is the value of the object it refers to. */
type Wrap<T, Inner> =
  T extends N<infer I>
    ? Wrap<I, Inner> | null
    : T extends L<infer I>
      ? Wrap<I, Inner>[]
      : T extends R<ObjectName>
        ? Inner
        : T;
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
  : Kind extends "query"
    ? Promise<V>
    : Field<V>;

type ObjectField<A, T, Name extends ObjectName, Kind = "field"> =
  NoArgs<A> extends true
    ? <S extends Selection>(select: Select<Name, S>) => Delivery<Kind, Wrap<T, Output<Name, S>>>
    : {} extends A
      ? {
          <S extends Selection>(select: Select<Name, S>): Delivery<Kind, Wrap<T, Output<Name, S>>>;
          <S extends Selection>(
            args: A | undefined,
            select: Select<Name, S>,
          ): Delivery<Kind, Wrap<T, Output<Name, S>>>;
        }
      : <S extends Selection>(
          args: A,
          select: Select<Name, S>,
        ) => Delivery<Kind, Wrap<T, Output<Name, S>>>;

type FieldOf<Definition> =
  Definition extends F<infer A, infer T>
    ? Unwrap<T> extends R<infer Name>
      ? ObjectField<A, T, Name>
      : ScalarField<A, Wrap<T, never>>
    : never;

/**
 * Selects fields on member `M` of a union or interface. Spread the result into the selection;
 * the result is then narrowed by `__typename`.
 */
type On<Name extends keyof Abstract> = <M extends Abstract[Name] & ObjectName, S extends Selection>(
  type: M,
  select: Select<M, S>,
) => { [K in `... on ${M}`]: Fragment<Output<M, S>> };

/**
 * The fields of object type `Name`, passed to selection callbacks. Reading a field selects it;
 * fields with arguments are called with them, and object fields with a nested selection.
 * Don't use `...rest` on it: the object is empty at runtime, so a rest element selects nothing.
 */
export type Fields<Name extends ObjectName> = {
  readonly [K in keyof Objects[Name]]: FieldOf<Objects[Name][K]>;
} & {
  /** The name of the object type. */
  readonly __typename: Field<Name extends keyof Abstract ? Abstract[Name] : Name>;
  /** Type-only: lets `Result` find the object type of a selection callback. */
  readonly [fieldsOf]?: Name;
} & (Name extends keyof Abstract ? { readonly $on: On<Name> } : {});

/**
 * The result of a reusable selection callback:
 * `const card = (performer: Fields<"Performer">) => ({ id: performer.id })` gives
 * `Result<typeof card>`, which is `{ id: string }`.
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

/** Arguments of a root field. */
export type Args<K extends RootField> =
  Root[K] extends F<infer A extends object, unknown> ? A : never;

type ScalarMethod<A, V, Kind> =
  NoArgs<A> extends true
    ? () => Delivery<Kind, V>
    : {} extends A
      ? (args?: A) => Delivery<Kind, V>
      : (args: A) => Delivery<Kind, V>;

type Method<Definition, Kind> =
  Definition extends F<infer A, infer T>
    ? Unwrap<T> extends R<infer Name>
      ? ObjectField<A, T, Name, Kind>
      : ScalarMethod<A, Wrap<T, never>, Kind>
    : never;

/** One method per root field: arguments first (when it has any), then the selection. */
export type RootMethods = {
  [K in keyof Root]: Method<Root[K], K extends SubscriptionField ? "subscription" : "query">;
};
