---
title: Operating model
---

How `lychee-norm-cache` uses the owned cache at run time, and how to set up the
two lanes a site needs: PR checks and a scheduled refresh. For the file itself,
see [The owned cache](cache-format.md).

## One rule

Every run, `lychee-norm-cache` projects `link-cache.jsonc` into the
`.lycheecache` CSV that lychee reads, runs lychee once, and folds lychee's
results back. The projection follows one rule, the `expires` rule:

- An entry **without** `expires` projects its real `when`, so lychee's
  `max_cache_age` decides whether it is served or re-checked.
- An entry **with** `expires` (lapsed or not) projects a fresh timestamp, so it
  is always served. Only `link-cache --prune` acts on a lapsed `expires`.
- Only 2xx results project. Failure words and non-2xx results re-check on every
  run.

There is no mode flag: PR checks, local runs, and the refresh lane run the same
command with the same projection.

## Two lanes

- **PR lane** (CI on a pull request, or a maintainer's local run): run the
  checker unflagged. It checks URLs the cache doesn't vouch for (absent, or with
  a non-2xx result) and entries older than `max_cache_age`; under a healthy
  refresh lane there are none of the latter. So a PR run's outcome and its cache
  diff depend only on what the PR changed.
- **Refresh lane**: a scheduled workflow that prunes the N oldest entries
  (`link-cache --prune N`; lapsed `expires` go too), runs the checker, and opens
  a PR with the cache changes. Live URLs come back with fresh timestamps, dead
  ones with failure words for triage. Size N so the cache rotates fully every
  few weeks.

Freshness comes from the refresh lane's prune, not from `max_cache_age`: a
pruned URL is uncached, and every run verifies uncached URLs.

## `max_cache_age`: the last-resort net

Set `max_cache_age` in `lychee.toml`; lychee's default is `1d`, which would
re-check most of the cache on every run. It is a safety net, not a refresh
mechanism: set it far above one full rotation (a year is typical). Under a
healthy refresh lane it never fires. When the refresh lane stops, entries
eventually age past it and PR runs start re-checking them; the refreshed
timestamps then showing up in PR diffs are the alarm, and the remedy is the
refresh lane, never the age.

## Merge-back

After lychee runs, results fold back into the owned file on positive evidence
only:

- A re-check that **changes** an entry's result replaces the entry: provenance
  moves to `lychee`; comments and `expires` go with the old claim.
- A **re-confirmation** leaves provenance-bearing entries (`manual`, named
  resolvers) untouched. A live re-check of a `lychee`-owned entry refreshes its
  `when` to record recency; a cache hit is not a re-check and leaves `when`
  untouched.
- A URL the run itself reports as **failing** is recorded with its failure word,
  keeping its comments and `expires`. Failure evidence counts only on a
  dead-links exit, and new failure entries mint for http(s) URLs only.
- An entry that merely goes **missing** from lychee's CSV is left untouched:
  cache-status excludes, cache aging, and site changes all remove entries from
  healthy runs.

For the full contract, see `mergeBack` in `lib/cache.mjs`.

## `lychee.toml` guidance

Prefer URL-scoped mechanisms (`exclude` patterns, or manual seeds in the owned
cache) for URL-specific problems, and reserve lychee's `accept` list for
statuses that are acceptable **site-wide**: an accepted status is recorded in
the committed cache for every URL that returns it. Note that `accept` buys no
caching: only 2xx results serve as cache hits, so an accepted non-2xx URL is
re-checked on every run.

Forwarded lychee flags apply for one run: for example, `--max-cache-age 0s`
makes lychee discard the whole cache file by age, so even `expires` entries
re-check.
