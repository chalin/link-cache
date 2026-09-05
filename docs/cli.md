---
title: CLI reference
---

The package installs two bins (plus a deprecated alias). Each bin's options,
their order semantics, and its exit codes live in its `--help` text, whose
source is the `USAGE` constant in the bin's entry file ([`check/index.mjs`][],
[`link-cache/index.mjs`][]); this page covers what `--help` doesn't: wiring,
requirements, and the behavior that matters to a site's workflows.

Wire the bins into `package.json` scripts under bare names and run them through
`npm run`, which puts `node_modules/.bin` on the `PATH`.

> [!WARNING]
>
> Don't invoke these bins via `npx`: on a stale or missing `node_modules`, `npx`
> falls back to the public registry and runs **whatever package holds the bin's
> name there** (the `lychee-norm-cache` name is squatted). Bare bin names in
> `npm run` scripts resolve through the `PATH` alone and never touch the
> registry.

## `lychee-norm-cache`

Runs in the current directory (your site root) over the built `public/` output,
projecting the owned cache and folding lychee's results back per
[Operating model](operating-model.md); without a `link-cache.jsonc`,
`.lycheecache` is normalized in place (legacy mode). `--import` converts an
existing `.lycheecache` to `link-cache.jsonc` instead (procedure:
[From a committed `.lycheecache`](migrate.md#from-a-committed-lycheecache-to-the-owned-cache)).

Requirements:

- The [lychee][] binary on your `PATH`.
- A `lychee.toml` at your site root (lychee's config and ignore rules).
- A built site under `public/` (run your site build first).
- Optional: the [`gh`][gh] CLI, whose token is bridged to lychee to raise the
  github.com rate limit when `GITHUB_TOKEN` isn't already set.

Anything the wrapper doesn't recognize passes through to lychee (`lychee --help`
lists the options; for example `--offline`, or `--max-cache-age` to override
`lychee.toml` for one run), with two exceptions: `--cache` is added when absent,
and `--cache=false` is rejected with an owned cache, since a cacheless run would
erase every projected entry on merge-back.

For CI wrappers: a warn-style wrapper can soften the dead-links exit (1,
advisory link rot) but must still fail hard on the preflight exit (2), which
means the check didn't actually run (an empty or fully-excluded `public/` is a
false-clean, not a pass).

## `link-cache`

Inspects and prunes a link cache: the owned `link-cache.jsonc` (default when
present) or a legacy lychee CSV like `.lycheecache`. Behavior that shapes a
refresh workflow:

- A prune drops every in-scope entry whose `expires` has lapsed, then the N
  oldest without an `expires`; entries whose `expires` holds are exempt.
  `--prune 0` drops lapsed entries only.
- A `--match` scope shields out-of-scope entries from the operations, never from
  a prune's rewrite: they always survive intact.
- Listing and pruning select differently: `--list` shows the oldest entries by
  timestamp, held `expires` rows included, while a prune skips those rows. So
  `-l 5 -p 5` previews the five oldest, not necessarily the five pruned.
- `--summary` and `--list` are read-only; a prune that drops nothing still
  writes back any normalization the read applied (resolved `+Nd` sugar,
  defaulted `when`, legacy fields).

## `refcache`

Deprecated alias of `link-cache`: it prints a warning and then behaves
identically.

## Examples

With the scripts from the [README quickstart](../README.md#quickstart):

```sh
npm run check:links
npm run link-cache -- --summary
npm run link-cache -- --match 'github\.com' --prune 10  # 10 oldest matching
npm run link-cache -- --prune 0  # lapsed entries only
```

<!-- prettier-ignore-start -->
[`check/index.mjs`]: ../check/index.mjs
[`link-cache/index.mjs`]: ../link-cache/index.mjs
[lychee]: https://github.com/lycheeverse/lychee
[gh]: https://cli.github.com/
<!-- prettier-ignore-end -->
