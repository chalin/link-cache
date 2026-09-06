---
title: Operating model
---

How `lychee-norm-cache` uses the owned cache at run time, and how to set up the
two lanes a site needs: PR checks and a scheduled refresh. For the file itself,
see [The owned cache](cache-format.md).

## One rule

Every run, `lychee-norm-cache` projects `link-cache.jsonc` into the
`.lycheecache` CSV that lychee reads, runs lychee once, and folds lychee's
results back. The projection follows one rule: **`expires` present, it governs;
absent, `max_cache_age` governs.**

- An entry **without** `expires` projects its real `when`, so lychee's
  `max_cache_age` decides whether it is served or re-checked.
- A 2xx entry **with** `expires`:
  - Projects a fresh timestamp, so it is served **lapsed or not**.
  - Is exempt from age-ordered pruning while `expires` holds (or forever, with
    `never`).
  - Is normally retired by the next prune once lapsed. The following check
    re-adds a live URL as a plain `lychee` entry or records a failure word. The
    override is one-shot, and the old entry's comments go with it.
  - Can be re-checked live when forced, as described under
    [Merge-back](#merge-back).
- Only 2xx results project. Failure words and non-2xx results re-check on every
  run.

There is no mode flag: PR checks, local runs, and the refresh lane run the same
command with the same projection.

## Two lanes

- **PR lane** (CI on a pull request, or a maintainer's local run): run the
  checker unflagged.
  - It checks URLs the cache doesn't vouch for (absent, or with a non-2xx
    result).
  - It also re-checks entries older than `max_cache_age`. For the age backstop,
    see [The last-resort net](#max_cache_age-the-last-resort-net).
  - Its cache diff is confined to those checks, apart from one-time
    normalization of hand edits (resolved `+Nd` sugar, a dated `when`-less seed)
    or of a legacy file.
- **Refresh lane**: a scheduled workflow that prunes the _`COUNT`_ oldest
  entries (`npm run link-cache -- --prune` _`COUNT`_), runs the checker, and
  opens a PR with the cache changes. Live URLs come back with fresh timestamps,
  dead ones with failure words for triage. Size _`COUNT`_ so the cache rotates
  fully every few weeks.

In CI, give the check step only the `GITHUB_TOKEN` it needs and install with
`npm ci --ignore-scripts`; the refresh lane's PR-opening step needs `contents`
and `pull-requests` write permission, so keep it in a separate job and let the
check itself run read-only.

## `max_cache_age`: the last-resort net

Set `max_cache_age` in `lychee.toml`: lychee's default is `1d`, which would
re-check most of the cache on every run. It is a safety net, not a refresh
mechanism: set it far above one full rotation (a year is typical). Under a
healthy refresh lane it never fires. When the refresh lane stops, entries
eventually age past it and PR runs start re-checking them: the refreshed
timestamps then showing up in PR diffs are the alarm, and the remedy is the
refresh lane, never the age.

## Merge-back

After lychee runs, results fold back into the owned file on positive evidence
only:

- A live re-check that returns a **different success status** replaces the
  entry: provenance moves to `lychee`; comments and `expires` go with the old
  claim (a failure instead follows the failing rule below). A live re-check of
  an entry whose `expires` has **lapsed** replaces it the same way, even when
  the result is unchanged (the override is spent). Such a re-check happens only
  when forced: `--max-cache-age 0s`, passed through for one run, makes lychee
  discard the whole cache by age. A forced run that completes within the same
  second as the projection reads as a cache hit instead, leaving the entry for
  the next prune.
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

## `lychee.toml` starter

A site root needs a `lychee.toml`; this one covers a built `public/` tree:

```toml
cache = true
max_cache_age = "365d"        # the last-resort net, far above one rotation
no_progress = true
extensions = ["html", "htm"]  # skip RSS and sitemap XML
include_fragments = "full"    # check anchors too
index_files = ["index.html"]  # resolve pretty URLs for fragment checks
exclude = [
  '[?&]link-check=no([&#]|$)', # per-link opt-out
]
```

Prefer URL-scoped mechanisms (`exclude` patterns, or manual seeds in the owned
cache) for URL-specific problems, and reserve lychee's `accept` list for
statuses that are acceptable **site-wide**: an accepted status is recorded in
the committed cache for every URL that returns it. For which results can be
cached, see the [projection rule](#one-rule).
