---
title: 'The owned cache: link-cache.jsonc'
---

`link-cache.jsonc` is the committed source of truth for a site's link-check
results: a JSONC file, pretty-printed in Prettier's style (so `prettier --check`
passes it untouched), sorted by URL, with `//` comments allowed on their own
lines. Consumers hand-edit it to seed entries; every check or prune that writes
it rewrites it deterministically.

Lychee's own CSV cache, `.lycheecache`, is **derived** from it. Commit
`link-cache.jsonc`; gitignore `.lycheecache`. For how the two files interact at
run time, see [Operating model](operating-model.md).

## Shape

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

The multi-line shape is deliberate: field-per-line entries keep concurrent
updates merging cleanly under git's normal 3-way merge. On a conflict, resolve
either way and rerun the check: the next run re-normalizes the file. Don't add a
`merge=union` gitattribute: on a multi-line file it can interleave entries into
invalid JSON.

## Keys

Key each entry by the URL exactly as lychee prints it: lowercase host, no
default port, resolved dot segments, and a `/` path on bare hosts
(`https://example.com/`, never `https://example.com`). Results merge back by
byte-for-byte key comparison, so a non-canonical spelling never matches its
re-check.

## Fields

- **`result`** (required): an HTTP status int (`200`, `206`, …), or a failure
  word from lychee's own tag vocabulary (`"error"`, `"timeout"`). Seed 2xx
  results only (for what each result does at run time, see
  [Operating model](operating-model.md#one-rule)); for an expected non-2xx
  status, use lychee's `exclude` or `accept` instead.
- **`when`**: the moment the result was established, as RFC3339 UTC at whole
  seconds (`YYYY-MM-DDTHH:MM:SSZ`), converting exactly to and from lychee's
  epoch-seconds cache timestamps. The form is strict (no fractional seconds, no
  offsets), so timestamps are byte-comparable and lexicographically
  chronological. A `manual` entry may omit it: the next check run or prune dates
  it. Other resolvers must write it.
- **`via`** (required): the resolver that set the result, one of `lychee`,
  `manual` (hand-seeded), or a named specialized resolver (for example, a
  browser-grade probe). Provenance says who established the result; it implies
  nothing about the entry's lifetime.
- **`expires`** (optional, any entry): the per-entry lifetime override of
  lychee's `max_cache_age`. For the rule and its two effects, serving and
  pruning, see [Operating model](operating-model.md#one-rule).
  - File grammar: `YYYY-MM-DD`, which lapses at the start of that UTC day (write
    `2026-10-01` to hold a seed through September 30), or `never`.
  - Input sugar: `+Nd` resolves to the date N days out, written by the first run
    that rewrites the file (the check, or a prune), so run the check before
    committing to pin the date. `+0d` resolves already lapsed: "re-verify at the
    next refresh".

## Comments

Each `//` comment attaches to the entry below it and travels with it through
[merge-back](operating-model.md#merge-back): it survives while the entry does
and goes when the entry is replaced (a stale rationale is worse than none).
Re-seed from the refresh PR if the rationale still matters.

## Compatibility

- 0.4.x files spelled `result` as `status`, with negative error codes; they're
  read compatibly and rewritten to `result` by the first check or prune that
  writes the file.
- 0.4.1 and 0.5.0 exempted every `manual` entry from pruning. Since 0.6.0, a
  `manual` entry **without** `expires` ages and rotates like any other entry;
  permanent trust is written `"expires": "never"`, never implied by a missing
  field.
- 0.5.0 held an `expires` date through the end of its UTC day; since 0.6.0 the
  date lapses at the day's start, so an existing dated seed is re-verified one
  refresh earlier at most.
