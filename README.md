# link-cache

Zero-dependency helper CLIs for **cached** link checking with [Lychee][], for
any static site that builds to a `public/` directory (Docsy, Hugo, and others).
Two tools:

- **`lychee-norm-cache`**: run lychee over your built `public/` output, keeping
  the committed `link-cache.jsonc` cache and lychee's derived `.lycheecache` in
  sync.
- **`link-cache`**: inspect and prune the cache. List the oldest entries, prune
  a count or percentage (optionally scoped by URL regex), or print a summary
  (result, provenance, ages). (`refcache` is a deprecated alias.)

With a committed `lychee.toml` and `link-cache.jsonc`, these give a site a
self-contained, cached link-checking setup: fast reruns, and diffs that reflect
real changes (link statuses, and check recency for freshly re-verified entries).

## Install

Requires [Node.js][] >= 24; `lychee-norm-cache` also needs the [lychee][] binary
on your `PATH` and a `lychee.toml` at your site root.

```sh
npm install --save-dev link-cache
```

Or, to install from GitHub rather than the npm registry:

```sh
npm install --save-dev github:chalin/link-cache#semver:^0.6.0
```

## Quickstart

Wire the bins into your `package.json` scripts, using bare names (`npm run` puts
`node_modules/.bin` on the `PATH`; never `npx`, for the reason the
[CLI reference](docs/cli.md) gives):

```json
"scripts": {
  "check:links": "lychee-norm-cache",
  "link-cache": "link-cache"
}
```

Create the owned cache as an empty object, build your site, set `max_cache_age`
in `lychee.toml` (a year is typical), then check:

```sh
echo '{}' > link-cache.jsonc     # once; without it the check runs cache-less
npm run check:links              # fills link-cache.jsonc
npm run link-cache -- --summary  # cache stats
```

- Commit `link-cache.jsonc`; gitignore `.lycheecache`.
- Run the check unflagged in PR checks.
- Add a scheduled workflow that prunes the oldest entries
  (`npm run link-cache -- --prune N`), re-checks, and opens a PR with the
  changes.

## Documentation

User docs, in `docs/`:

- [The owned cache](docs/cache-format.md): the `link-cache.jsonc` format, its
  fields, hand-seeding entries, `expires`.
- [Operating model](docs/operating-model.md): the projection rule, the PR and
  refresh lanes, `max_cache_age`, merge-back.
- [CLI reference](docs/cli.md): wiring, requirements, workflow-relevant
  behavior.
- [Migrating to lychee and link-cache](docs/migrate.md): from htmltest, and from
  a committed `.lycheecache`.

Maintainer docs, in `_docs/`:

- [Release runbook](_docs/release.md)
- [Supply-chain posture](_docs/supply-chain.md)

## Development

```sh
npm run install:safe
npm run check
```

Tests use Node's built-in test runner (`node --test`) and need no network or the
lychee binary.

<!-- prettier-ignore-start -->
[Lychee]: https://github.com/lycheeverse/lychee
[Node.js]: https://nodejs.org/
<!-- prettier-ignore-end -->
