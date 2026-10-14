# Contributing

You need [Bun](https://bun.sh) to run the scripts and tests (the version is pinned in `package.json`).

```sh
npm install
bun check          # type check
bun run lint       # oxfmt and oxlint
bun test           # also type-checks the examples in the README
bun run build      # writes dist
bun run verify     # all of the above, the same as CI
```

[`example/index.ts`](example/index.ts) is a script you can run against your own Stash server:

```sh
STASH_URL=http://localhost:9999 STASH_API_KEY=... bun example/index.ts
```

`src/generated` and `schema/` are generated from the schema of a Stash release, so don't edit them by hand. Run `bun run schema` to update them to the latest Stash release (or `bun run schema v0.30.0` for a specific one).
