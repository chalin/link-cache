# link-cache

Zero-dependency helper CLIs for **cached** link checking with [Lychee][], for
any static site that builds to a `public/` directory (Docsy, Hugo, and others).
Two tools:

- **`lychee-norm-cache`** — run lychee over your built `public/` output, then
  normalize `.lycheecache` so reruns and commits stay byte stable.
- **`refcache`** — inspect and prune that `.lycheecache` (the "refcache"): list
  the oldest entries, prune a count or percentage, or print a summary.

With a committed `lychee.toml` and `.lycheecache`, these give a site a
self-contained, cached link-checking setup: fast reruns, and diffs that only
change when links actually change.

## Requirements

- The [lychee][] binary on your `PATH`.
- A `lychee.toml` at your site root (lychee's config and ignore rules).
- A built site under `public/` (run your site build first).
- [Node.js][] ≥ 24.
- Optional: the [`gh`][gh] CLI — `lychee-norm-cache` bridges its token to lychee
  to raise the github.com rate limit when `GITHUB_TOKEN` isn't already set.

## Install

Until this package is published to the npm registry, install it from GitHub:

```sh
npm install --save-dev github:chalin/link-cache
```

This puts both bins on your project's `PATH`.

## Usage

```sh
npx lychee-norm-cache    # check links, then sort/normalize the cache
npx refcache --summary   # cache stats (count, oldest, status, ages)
```

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
