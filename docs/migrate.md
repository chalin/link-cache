---
title: Migrating to lychee and link-cache
---

Two migrations, in the order sites typically meet them: from [htmltest][] (with
a committed `refcache.json`) to lychee, and from a committed `.lycheecache` to
the owned `link-cache.jsonc`. A site starting fresh with lychee skips both: the
[README quickstart](../README.md#quickstart) and [CI](#ci) below cover it.

## From htmltest to lychee

### Inventory the incumbent

Catalog what htmltest carries. Every item needs a lychee disposition: ported,
replaced, or dropped.

- Config: `.htmltest.yml` (`IgnoreDirs`, `IgnoreURLs`, `IgnoreInternalURLs`).
- The committed refcache and its refresh or prune scripts. Note which cache file
  is committed and which is derived; the switch may invert that, so `.gitignore`
  is part of the inventory.
- CI wiring.
- Skip markers (`data-proofer-ignore`, query-string markers).
- Makefile or npm entry points.

### Reach offline parity over the built site

Build, then run lychee offline over `public/` and drive the error count to
htmltest parity before touching anything online:

- Start from a `lychee.toml`, not bare flags. Fragment checks need both
  `include_fragments` and `index_files = ["index.html"]`: without the latter,
  pretty URLs (`/foo/`) fail fragment checks en masse.
- Port `IgnoreDirs` to `exclude_path` and `IgnoreURLs` to `exclude` regexes.
- Set `extensions = ["html"]`: without it, RSS and sitemap XML built with a
  localhost `baseURL` flood the run with bogus errors.
- Lychee has no element-level ignore marker. Convert each tagged element to a
  URL `exclude` (for example, per-page GitHub `commit/` links) or to
  `rel="nofollow"`, which lychee skips natively.
- If the incumbent generates its config (say, from page front matter), port the
  chain to one lychee-native generator and diff its `lychee.toml` output against
  the old chain's before deleting the old chain.

### Seed the cache online

- Lychee reads only `GITHUB_TOKEN` or `--github-token`: `gh auth login` alone
  does nothing. `lychee-norm-cache` bridges the `gh` token for local runs; in
  CI, set `GITHUB_TOKEN` on the check step. Without a token, a green check may
  be green only because the cache covers every github.com URL.
- If github.com still throttles, look for per-page query-string variants (for
  example, `issues/new?title=PAGE` footer links) and exclude the pattern rather
  than seeding hundreds of variants.
- Expect real link rot: a fresh online check surfaces what the stale refcache
  masked. Triage into systematic upstream restructures (scripted fix), content
  fixes, permanently unverifiable URLs (a commented `exclude`, or a `manual`
  seed with `"expires": "never"` for a URL a human verified), and transient
  pre-release links (a `manual` seed with a dated `expires`).
- Seed choice scales with the cache: a small cache seeds fresh (translation
  would carry the stale entries the switch is meant to flush); a cache of
  thousands translates the old refcache for trust parity and lets the refresh
  lane flush rot over time. The tools import only lychee's CSV, so translation
  is a one-off script from `refcache.json` to `.lycheecache`, followed by a
  check run and then `--import`.
- Commit the post-run cache, not a raw translation: lychee canonicalizes
  bare-origin URLs (`https://x.com` becomes `https://x.com/`), so only a cache
  that has been through a full run is byte-stable.

### Wire the repo

- Add `link-cache` as a devDependency and wire check, refresh, and inspect
  scripts under bare bin names, adapted to the repo's own npm-script conventions
  (see [CLI reference](cli.md)). Keep consumer-facing script names even when
  their meaning changes: workflows and contributor habits consume the name.
- npm `--` forwarding carries one level per `--`: a script defined as
  `npm run inner` swallows forwarded arguments unless its definition ends with a
  trailing `--`. Verify with `npm run check:links -- --help`, which must print
  the wrapper's usage (a swallowed flag runs the check instead).
- Don't blanket-exclude on 403 or 429 as policy: bot walls aren't rot. Interim
  excludes are fine to ship; re-fetching 4xx URLs with browser-like headers is
  the follow-up.

### CI

- Install a pinned lychee binary via `curl` rather than `lychee-action` (no
  install-only mode, and a second trust surface). With several consuming
  workflows, put the install step in a shared composite action so the version
  pin has one home. Install to a directory already on the runner's default
  `PATH`.
- Make the PR check blocking, and give deploys a non-blocking variant (soften
  exit 1, fail on exit 2) so a cold-cache throttle can't block a deploy.
- Add offline sanity tests (fragment and index-file behavior, binary presence)
  so config regressions don't need a full build to surface.
- Set up the refresh lane per [Operating model](operating-model.md) and decide
  how the pinned lychee version gets bumped.

### Switch

- Remove htmltest, `refcache.json`, prune or refresh scripts, bridges, and make
  targets in one PR; migrate skip markers (for example to a `?link-check=no`
  query marker) in content and the `lychee.toml` regex together.
- Sweep for the cache file's identity roles: CODEOWNERS, auto-merge allowlists,
  label maps, spell-check `ignorePaths`. The new cache file inherits each
  mention.
- Sweep docs and tooling for the old toolchain's name, including derived
  references: scripts that mention dropped npm scripts, fallback hints, and
  anchors that translations link to.
- Prove the signal before merging, as temporary commits reverted before review:
  a real-domain 404 must turn the check red (lychee skips reserved TLDs such as
  `.invalid`), and a valid but uncached link must produce a cache diff. Confirm
  the reported link count is plausible: a silent no-op looks exactly like
  success.
- Links to files the PR itself adds 404 until merge: name such paths as code, or
  seed the entry deliberately.
- Validate through the consumer path (`npm run SCRIPT`), not only a direct
  `node PATH/index.mjs`.

## From a committed `.lycheecache` to the owned cache

Without a `link-cache.jsonc`, `lychee-norm-cache` falls back to the legacy mode:
normalize the committed `.lycheecache` in place. To import an existing CSV
cache:

```sh
npm run check:links -- --import   # .lycheecache -> link-cache.jsonc
```

Then commit `link-cache.jsonc` and gitignore `.lycheecache`. If the CSV cache
carried a `merge=union` gitattribute, drop it rather than moving it over (it
proved ineffective on the CSV, and it corrupts the owned file:
[The owned cache](cache-format.md#shape)).

Workflow deltas are limited to the file's identity: artifact upload paths,
cache-diff guards, and header comments that named `.lycheecache` now name
`link-cache.jsonc`. Prune and check steps are unchanged in shape.

<!-- prettier-ignore-start -->
[htmltest]: https://github.com/wjdp/htmltest
<!-- prettier-ignore-end -->
