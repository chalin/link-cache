# link-cache

Zero-dependency helper CLIs for **cached** link checking with [Lychee][], for
any static site that builds to a `public/` directory (Docsy, Hugo, and others).
Two tools:

- **`lychee-norm-cache`** — run lychee over your built `public/` output, keeping
  the committed `link-cache.jsonc` cache and lychee's derived `.lycheecache` in
  sync.
- **`link-cache`** — inspect and prune the cache: list the oldest entries, prune
  a count or percentage (optionally scoped by URL regex; `manual` entries are
  exempt — they retire via their `expires` date), or print a summary (status,
  provenance, ages). (`refcache` is a deprecated alias.)

With a committed `lychee.toml` and `link-cache.jsonc`, these give a site a
self-contained, cached link-checking setup: fast reruns, and diffs that reflect
real changes — link statuses, and check recency for freshly re-verified entries.

## The owned cache: `link-cache.jsonc`

The committed source of truth is `link-cache.jsonc` — a JSONC file,
pretty-printed by construction in Prettier's style (so `prettier --check` passes
it untouched), one multi-line object per URL, sorted, with `//` comments allowed
on their own lines. Each comment attaches to the entry below it and survives
rewrites for as long as the entry's status holds; a status change replaces the
entry and retires its comments (a stale rationale is worse than none). The
multi-line shape is deliberate: field-per-line entries keep concurrent updates
merging cleanly under git's normal 3-way merge.

```jsonc
{
  "https://example.com/": {
    "result": 200,
    "when": "2026-08-29T20:06:38Z",
    "via": "lychee",
  },
  // Seeded pending my-org/repo#123; the target lands with that merge.
  "https://example.com/future-page/": {
    "result": 200,
    "when": "2026-08-29T20:06:38Z",
    "via": "manual",
    "expires": "2026-09-30",
  },
}
```

Each entry records:

- **`result`** — an HTTP status int (`200`, `206`, …), or a failure word from
  lychee's own tag vocabulary (`"error"`, `"timeout"`). Only HTTP results are
  handed to lychee's cache; failure words live in the owned file only. (0.4.x
  files spelled this field `status` with negative error codes; they're read
  compatibly and rewritten to `result` on the first run.)
- **`when`** — the moment the status was established, as RFC3339 UTC at whole
  seconds (`YYYY-MM-DDTHH:MM:SSZ`), converting exactly to and from lychee's
  epoch-seconds cache timestamps. The form is strict — no fractional seconds, no
  offsets — so timestamps are byte-comparable and lexicographically
  chronological.
- **`via`** — the resolver that set the status: `lychee`, `manual`
  (hand-seeded), or a named specialized resolver (e.g. a browser-grade probe).
  Key hand-seeded entries by the URL exactly as lychee prints it: lowercase
  host, no default port, resolved dot segments, and a `/` path on bare hosts
  (`https://example.com/`, never `https://example.com`). Results merge back by
  byte-for-byte key comparison, so a non-canonical spelling never matches its
  re-check.
- **`expires`** (optional, `manual` entries) — `YYYY-MM-DD`. Until then the
  entry is trusted; after that, a `--check-stale` run re-checks it live and
  replaces it with the verified result.

Lychee's own CSV cache, `.lycheecache`, is **derived**: `lychee-norm-cache`
projects the owned cache into it before each run and folds lychee's results back
afterwards. Gitignore `.lycheecache`; commit `link-cache.jsonc`. A re-check that
changes an entry's result replaces the entry (provenance moves to `lychee`); a
re-confirmation leaves provenance-bearing entries (`manual`, named resolvers)
untouched, while `lychee`-owned entries refresh their `when` to record recency.
A URL the run itself reports as failing is recorded with its failure word; an
entry that merely goes missing from lychee's CSV is left untouched (cache-status
excludes, cache aging, and site changes all remove entries from healthy runs).
Failure evidence counts only on a dead-links exit, and new failure entries mint
for http(s) URLs only; for the rationale, see `mergeBack`'s contract in
`lib/cache.mjs`.

## Two modes: PR checks vs. cache refresh

By default, `lychee-norm-cache` does **not apply staleness checks**: every
cached entry is projected into lychee's CSV with a fresh timestamp, so lychee's
`max_cache_age` never triggers and expired manual seeds aren't re-checked. A
default run verifies **only the URLs not in the cache** — the right behavior for
PR checks, which should validate the change at hand, not inherit re-checks of
aging entries. Entries still age for real: their `when` timestamps are untouched
in the owned file; the default just doesn't act on the age.

With **`--check-stale`**, real timestamps are projected, so `max_cache_age` and
manual `expires` dates bite: stale and expired entries are re-verified. This is
the mode for a scheduled cache-refresh (housekeeping) lane. In steady state,
`link-cache --prune` and `--check-stale` runs are what drive re-checks.

Because the default never re-checks cached entries, a dead refresh lane rots the
cache silently. Guard against that with the staleness guard:

```sh
link-cache --max-age 60   # exit 3 if the oldest checked entry is >60 days old
```

Set the threshold from your lychee `max_cache_age` minus at least one refresh
interval, and run the guard wherever its failure gets seen (the refresh lane
itself, or another scheduled job). Manual seeds are exempt — their lifecycle is
owned by their `expires` date.

Without a `link-cache.jsonc`, `lychee-norm-cache` falls back to the legacy mode:
normalize the committed `.lycheecache` in place. To migrate:

```sh
npm run check:links -- --migrate   # .lycheecache -> link-cache.jsonc
```

then commit `link-cache.jsonc` and gitignore `.lycheecache`. If the CSV cache
carried a `merge=union` gitattribute, drop it rather than moving it over: union
merging proved ineffective in practice, and on a multi-line file it can
interleave entries into invalid JSON. The owned cache merges with git's normal
3-way merge; on a conflict, resolve either way and rerun the check — the next
run re-normalizes the file.

In your `lychee.toml`, prefer URL-scoped mechanisms for URL-specific problems —
`exclude` patterns, or manual seeds in the owned cache — and reserve lychee's
`accept` list for statuses that are acceptable **site-wide**: an accepted status
is recorded in the committed cache for every URL that returns it.

## Exit codes (`lychee-norm-cache`)

- `0` — success.
- `1` — dead links: the check ran and found failures.
- `2` — preflight or sanity failure: lychee or `public/` missing, lychee config
  error, or **zero links checked** (an empty or fully-excluded `public/` is a
  false-clean, not a pass).

Warn-style wrappers can soften exit 1 (advisory link rot) while still failing
hard on exit 2 (the check didn't actually run).

## Requirements

- The [lychee][] binary on your `PATH`.
- A `lychee.toml` at your site root (lychee's config and ignore rules).
- A built site under `public/` (run your site build first).
- [Node.js][] ≥ 24.
- Optional: the [`gh`][gh] CLI — `lychee-norm-cache` bridges its token to lychee
  to raise the github.com rate limit when `GITHUB_TOKEN` isn't already set.

## Install

```sh
npm install --save-dev link-cache
```

Or, to install from GitHub rather than the npm registry:

```sh
npm install --save-dev github:chalin/link-cache#semver:^0.4.0
```

This puts both bins on your project's `PATH`.

## Usage

Wire the bins into your `package.json` scripts (bare names — `npm run` puts
`node_modules/.bin` on the `PATH`):

```json
"scripts": {
  "check:links": "lychee-norm-cache",
  "link-cache": "link-cache"
}
```

```sh
npm run check:links              # verify URLs not yet in the cache
npm run check:links -- --check-stale  # also re-verify stale/expired entries
npm run link-cache -- --summary  # cache stats (count, oldest, result, via, ages)
npm run link-cache -- --match 'github\.com' --prune 10  # trim 10 oldest matching
npm run link-cache -- --no-manual --list 5  # 5 oldest, skipping manual seeds
npm run link-cache -- --max-age 60  # staleness guard (exit 3 when breached)
```

> [!WARNING]
>
> Don't invoke these bins via `npx`: on a stale or missing `node_modules`, `npx`
> falls back to the public registry and runs **whatever package holds the bin's
> name there** (the `lychee-norm-cache` name is squatted). Bare bin names in
> `npm run` scripts resolve locally or fail loudly — they never touch the
> registry.

`lychee-norm-cache` runs in the current directory (your site root) and forwards
any extra arguments to lychee. Run either tool with `--help` for its full
options, and `lychee --help` for the link-checking flags `lychee-norm-cache`
forwards (e.g. `--offline`, `--max-cache-age 0`).

## Development

The published CLIs have **zero runtime dependencies**; Prettier is the only dev
dependency. The committed `.npmrc` applies the usual supply-chain controls
(lock-exact installs, script execution default-deny, release cooldown). Run the
checks (format + tests) with:

```sh
npm run install:safe
npm run check
```

Tests use Node's built-in test runner (`node --test`) and need no network or the
lychee binary.

<!-- prettier-ignore-start -->
[Lychee]: https://github.com/lycheeverse/lychee
[Node.js]: https://nodejs.org/
[gh]: https://cli.github.com/
<!-- prettier-ignore-end -->
