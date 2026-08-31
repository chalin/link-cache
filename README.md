# link-cache

Zero-dependency helper CLIs for **cached** link checking with [Lychee][], for
any static site that builds to a `public/` directory (Docsy, Hugo, and others).
Two tools:

- **`lychee-norm-cache`** — run lychee over your built `public/` output, keeping
  the committed `link-cache.jsonc` cache and lychee's derived `.lycheecache` in
  sync.
- **`refcache`** — inspect and prune the cache: list the oldest entries, prune a
  count or percentage, or print a summary (status, provenance, ages).

With a committed `lychee.toml` and `link-cache.jsonc`, these give a site a
self-contained, cached link-checking setup: fast reruns, and diffs that only
change when links actually change.

## The owned cache: `link-cache.jsonc`

The committed source of truth is `link-cache.jsonc` — a JSONC file,
pretty-printed by construction in Prettier's style (so `prettier --check` passes
it untouched), one multi-line object per URL, sorted, with `//` comments allowed
on their own lines (each comment attaches to the entry below it and survives
rewrites). The multi-line shape is deliberate: field-per-line entries keep
concurrent updates merging cleanly under git's normal 3-way merge.

```jsonc
{
  // Seeded pending my-org/repo#123; the target lands with that merge.
  "https://example.com/future-page/": {
    "status": 200,
    "ts": 1788033998,
    "via": "manual",
    "expires": "2026-09-30",
  },
  "https://example.com/": {
    "status": 200,
    "ts": 1788033998,
    "via": "lychee",
  },
}
```

Each entry records:

- **`status`** — generalized: positive values are HTTP statuses; `0` is
  unchecked; negative values are tool-specific errors (`-10` timeout, `-20`
  network/DNS, `-30` certificate, `-40` generic client error).
- **`ts`** — unix seconds of the last verification.
- **`via`** — the resolver that set the status: `lychee`, `manual`
  (hand-seeded), or a named specialized resolver (e.g. a browser-grade probe).
- **`expires`** (optional, `manual` entries) — `YYYY-MM-DD`. Until then the
  entry is trusted (never re-checked, overriding lychee's `max_cache_age`);
  after that, it's re-checked live and replaced by the verified result.

Lychee's own CSV cache, `.lycheecache`, is **derived**: `lychee-norm-cache`
projects the owned cache into it before each run and folds lychee's results back
afterwards. Gitignore `.lycheecache`; commit `link-cache.jsonc`. Lychee re-check
results overwrite an entry only when its status changes; an entry lychee drops
(it never persists errors) is recorded as a negative tool-error status.

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
npm install --save-dev github:chalin/link-cache#semver:^0.3.0
```

This puts both bins on your project's `PATH`.

## Usage

Wire the bins into your `package.json` scripts (bare names — `npm run` puts
`node_modules/.bin` on the `PATH`):

```json
"scripts": {
  "check:links": "lychee-norm-cache",
  "refcache": "refcache"
}
```

```sh
npm run check:links            # sync caches, run lychee, fold results back
npm run refcache -- --summary  # cache stats (count, oldest, status, via, ages)
npm run refcache -- --match 'github\.com' --prune 10   # trim 10 oldest matching
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
dependency. Run the checks (format + tests) with:

```sh
npm install
npm run check
```

Tests use Node's built-in test runner (`node --test`) and need no network or the
lychee binary.

<!-- prettier-ignore-start -->
[Lychee]: https://github.com/lycheeverse/lychee
[Node.js]: https://nodejs.org/
[gh]: https://cli.github.com/
<!-- prettier-ignore-end -->
