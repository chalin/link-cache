---
title: CLI reference
---

For options and exit codes, run either bin with `--help`; `link-cache` also
describes operation order there. The help text lives in the `USAGE` constants in
[`check/index.mjs`][] and [`link-cache/index.mjs`][].

## Install

Requires [Node.js][] >= 24. For the checker's additional prerequisites, see
[`lychee-norm-cache`](#lychee-norm-cache).

```sh
npm install --save-dev link-cache
```

### Install from GitHub

For GitHub installs, allow direct git dependencies in the project's `.npmrc`.
npm 12 rejects them by default; a command-line opt-in alone would not carry over
to a later `npm ci` run.

```sh
npm config set --location=project allow-git=root
npm install --save-dev github:chalin/link-cache#semver:^0.6.0
```

Commit the `.npmrc` change along with the dependency declaration and lockfile so
local and CI installs use the same policy.

## Quickstart

Wire the bins into `package.json` scripts under bare names and run them through
`npm run`, which puts `node_modules/.bin` on the `PATH`:

```json
"scripts": {
  "check:links": "lychee-norm-cache",
  "link-cache": "link-cache"
}
```

For a new cache, create `link-cache.jsonc` containing `{}` in UTF-8. For an
existing CSV cache, use the [import procedure][import] instead. Add a
`lychee.toml` from the [starter][starter], build the site, then run:

```sh
npm run check:links
npm run link-cache -- --summary
```

Commit `link-cache.jsonc` and gitignore the derived `.lycheecache`. For PR
checks and scheduled refreshes, follow the [two-lane setup][lanes].

### Argument forwarding

Arguments after `--` reach the bin one script level deep: a script defined as
`npm run inner` swallows them unless its definition ends with a trailing `--`.
Verify with `npm run check:links -- --help`, which must print the wrapper's
usage (a swallowed flag runs the check instead).

> [!WARNING]
>
> Don't invoke these bins via `npx`: on a stale or missing `node_modules`, `npx`
> falls back to the public registry and runs **whatever package holds the bin's
> name there** (the `lychee-norm-cache` name was squatted). Bare bin names in
> `npm run` scripts never touch the registry.

## `lychee-norm-cache`

Runs in the current directory (your site root) over the built `public/` output,
projecting the owned cache and folding lychee's results back per
[Operating model](operating-model.md). `--import` converts an existing
`.lycheecache` to `link-cache.jsonc` instead (procedure:
[From a committed `.lycheecache`](migrate.md#from-a-committed-lycheecache-to-the-owned-cache)).

Requirements:

- The [lychee][] binary on your `PATH`.
- A `lychee.toml` at your site root (lychee's config and ignore rules).
- A built site under `public/` (run your site build first).
- Optional: the [`gh`][gh] CLI, whose token is bridged to lychee to raise the
  github.com rate limit when `GITHUB_TOKEN` isn't already set.

Anything the wrapper doesn't recognize passes through to lychee (`lychee --help`
lists the options; for example `--offline`, or `--max-cache-age` to override
`lychee.toml` for one run), except the stdout-diverting flags `--help` names as
unsupported and two cache flags: `--cache` is added when absent, and
`--cache=false` is rejected with an owned cache, since without lychee's cache
file nothing is served from the owned cache and no results fold back.

For CI wrappers: a warn-style wrapper can soften the dead-links exit (1,
advisory link rot) but must still fail hard on the preflight exit (2), which
means the check didn't actually run (an empty or fully-excluded `public/` is a
false-clean, not a pass).

## `link-cache`

The cache inspector and pruner, for the owned file (the default when present) or
a legacy CSV. Its `--help` covers the operations; how the refresh lane uses a
prune is in [Operating model](operating-model.md#two-lanes).

## `refcache`

Deprecated alias of `link-cache`: it prints a warning and then behaves
identically.

## Examples

With the scripts from the [quickstart](#quickstart):

```sh
npm run link-cache -- --match "github\.com" --prune 10  # lapsed, then 10 oldest
npm run link-cache -- --prune 0  # lapsed entries only
```

<!-- prettier-ignore-start -->
[`check/index.mjs`]: ../check/index.mjs
[gh]: https://cli.github.com/
[import]: migrate.md#from-a-committed-lycheecache-to-the-owned-cache
[lanes]: operating-model.md#two-lanes
[`link-cache/index.mjs`]: ../link-cache/index.mjs
[lychee]: https://github.com/lycheeverse/lychee
[Node.js]: https://nodejs.org/
[starter]: operating-model.md#lycheetoml-starter
<!-- prettier-ignore-end -->
