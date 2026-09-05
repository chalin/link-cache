---
title: CLI reference
---

The package installs two bins (plus a deprecated alias). Wire them into
`package.json` scripts under bare names (`npm run` puts `node_modules/.bin` on
the `PATH`) and run them through `npm run`; each also answers `--help`.

> [!WARNING]
>
> Don't invoke these bins via `npx`: on a stale or missing `node_modules`, `npx`
> falls back to the public registry and runs **whatever package holds the bin's
> name there** (the `lychee-norm-cache` name is squatted). Bare bin names in
> `npm run` scripts resolve locally or fail loudly; they never touch the
> registry.

## `lychee-norm-cache`

```text
lychee-norm-cache [--import] [LYCHEE_ARGS...]
```

Runs in the current directory (your site root) over the built `public/` output,
projecting the owned cache and folding lychee's results back per
[Operating model](operating-model.md); without a `link-cache.jsonc`,
`.lycheecache` is normalized in place (legacy mode).

- `--import`: convert an existing `.lycheecache` to `link-cache.jsonc` and exit.
  For the procedure, see
  [From a committed `.lycheecache`](migrate.md#from-a-committed-lycheecache-to-the-owned-cache).
- `-h`, `--help`: show help.
- Anything else passes through to lychee (`lychee --help` lists the options; for
  example `--offline`, or `--max-cache-age` to override `lychee.toml` for one
  run), with two exceptions: `--cache` is added when absent, and `--cache=false`
  is rejected with an owned cache, since a cacheless run would erase every
  projected entry on merge-back.

Requirements:

- The [lychee][] binary on your `PATH`.
- A `lychee.toml` at your site root (lychee's config and ignore rules).
- A built site under `public/` (run your site build first).
- Optional: the [`gh`][gh] CLI, whose token is bridged to lychee to raise the
  github.com rate limit when `GITHUB_TOKEN` isn't already set.

Lychee's summary must reach stdout in its default or JSON format: it is the
wrapper's proof that a check completed. Flags that divert or reshape stdout
(`--output`, `--format junit`, `--dump-inputs`, …) are unsupported here; run
lychee directly for those.

Exit codes:

- `0`: success.
- `1`: dead links (the check ran and found failures).
- `2`: preflight or sanity failure (lychee or `public/` missing, lychee config
  or usage error, or **zero links checked**; an empty or fully-excluded
  `public/` is a false-clean, not a pass).

Warn-style wrappers can soften exit 1 (advisory link rot) while still failing
hard on exit 2 (the check didn't actually run).

## `link-cache`

```text
link-cache [CACHE_FILE] [options]
```

Inspects and prunes a link cache: the owned `link-cache.jsonc` (default when
present) or a legacy lychee CSV like `.lycheecache`. With no options, prints the
summary. A flag may not be repeated.

- `-l`, `--list NUM`: list the NUM oldest entries (with their `expires`, if any;
  lapsed ones are marked).
- `-m`, `--match REGEX`: scope all operations to URLs matching REGEX.
  Out-of-scope entries are shielded from the operations, never from a prune's
  rewrite: they always survive intact.
- `-p`, `--prune NUM[%]`: drop every in-scope entry whose `expires` has lapsed,
  then the NUM oldest without an `expires` (NUM% of those), and rewrite the
  file; entries whose `expires` holds are exempt. `--prune 0` drops lapsed
  entries only. A prune that drops nothing still writes back any normalization
  the read applied (resolved `+Nd` sugar, defaulted `when`, legacy fields).
- `-s`, `--summary`: print a summary (counts, ages, result, via, histogram).
  Read-only, as is `--list`.
- `-h`, `--help`: show help.

Options run in the order given, over the evolving cache: `-l 5 -p 5` lists the 5
oldest before pruning them; `-p 5 -l 5` lists the next 5 after pruning.

Exit codes: `0` success; `1` unreadable or malformed owned cache file (a legacy
CSV's malformed lines are skipped and counted in the summary); `2` usage error.

## `refcache`

Deprecated alias of `link-cache`; it prints a warning and then behaves
identically.

## Examples

With the scripts from the [README quickstart](../README.md#quickstart):

```sh
npm run check:links
npm run link-cache -- --summary  # cache stats (count, oldest, result, via, ages)
npm run link-cache -- --match 'github\.com' --prune 10  # trim 10 oldest matching
npm run link-cache -- --prune 0  # drop only entries whose expires has lapsed
```

<!-- prettier-ignore-start -->
[lychee]: https://github.com/lycheeverse/lychee
[gh]: https://cli.github.com/
<!-- prettier-ignore-end -->
