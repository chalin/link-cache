---
title: CLI reference
---

The package installs two bins (plus a deprecated alias). Each bin's options and
exit codes (and, for `link-cache`, the order semantics) live in its `--help`
text, whose source is the `USAGE` constant in the bin's entry file
([`check/index.mjs`][], [`link-cache/index.mjs`][]). This page covers wiring and
the behavior that matters to a site's workflows, and repeats the requirements
for readers who haven't installed yet.

Wire the bins into `package.json` scripts under bare names and run them through
`npm run`, which puts `node_modules/.bin` on the `PATH`. Arguments after `--`
reach the bin one script level deep: a script defined as `npm run inner`
swallows them unless its definition ends with a trailing `--`. Verify with
`npm run check:links -- --help`, which must print the wrapper's usage (a
swallowed flag runs the check instead).

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

Beyond the [README quickstart](../README.md#quickstart)'s check and summary:

```sh
npm run link-cache -- --match "github\.com" --prune 10  # lapsed, then 10 oldest
npm run link-cache -- --prune 0  # lapsed entries only
```

<!-- prettier-ignore-start -->
[`check/index.mjs`]: ../check/index.mjs
[gh]: https://cli.github.com/
[`link-cache/index.mjs`]: ../link-cache/index.mjs
[lychee]: https://github.com/lycheeverse/lychee
<!-- prettier-ignore-end -->
