---
title: Release runbook
---

How a `link-cache` version reaches npm, and what follows in the consuming sites.
The only publish trigger is a GitHub release. For why the workflow is shaped as
it is, see [Supply-chain posture](supply-chain.md). One-time setup, already done
for this package: on npmjs.com, the package's Settings > Trusted Publisher names
this repo and [`publish.yaml`][] as the publisher.

## Before tagging

1. `main` holds everything meant for the release (docs and code land before the
   tag, not after), and its head's [`check.yaml`][] run is green. This is the
   gate (why: [Supply-chain posture](supply-chain.md)).
2. `package.json` `version` is the release version, _`VERSION`_ below (the
   publish workflow refuses a tag that doesn't match it). If a bump is needed,
   land it in its own commit with `npm version` _`VERSION`_
   `--no-git-tag-version`, which moves the lockfile's copy too.
3. Locally, from a clean checkout of `main`:

   ```sh
   npm run install:safe
   npm run check
   npm pack --dry-run
   ```

   Read the pack listing against `files` in `package.json`: only the bins and
   their `lib/` modules ship (plus the manifest, README, and license that npm
   always includes). No tests, docs, or maintainer pages.

4. Review the diff since the previous tag for behavior changes consumers must
   act on: they become the release notes.

## Tag and release

1. Tag the merge commit, _`MERGE_SHA`_: `git tag v`_`VERSION`_ _`MERGE_SHA`_,
   then `git push origin v`_`VERSION`_.
2. Create the GitHub release from the tag, with notes: a one-line summary,
   behavior changes and any migration steps, then the merged PRs. The
   `release: published` event triggers [`publish.yaml`][].
3. Watch the [`publish.yaml`][] run: it asserts the tag matches `package.json`
   and publishes, with no install step.
4. Verify on npm: the version appears with a provenance badge,
   `npm view link-cache version` prints it, and the README's doc links on the
   package page resolve (npm rewrites them to this repo).

If the workflow fails after the tag exists, fix on `main`, bump the patch
version, and release again; never move or delete a published tag.

## Consumer bumps

Consumers pin the package, so each release is followed by bump PRs. Where the
consumer's `.npmrc` sets a cooldown (`min-release-age=7`: docsy, docsy-starter,
opentelemetry.io), a version younger than a week is rejected, so open those
bumps a week after publishing, or wait out the cooldown in the bump branch;
docsy-example has no cooldown. Current consumers and what a bump touches:

- **[google/docsy][]** (docsy.dev): the `docsy.dev/package.json` pin, the PR
  check workflow, and the scheduled refresh workflow; the repo's maintainer
  notes describe the cache semantics.
- **[google/docsy-example][]**: `package.json` pin and its check scripts; no
  refresh lane.
- **[chalin/docsy-starter][]**: `package.json` pin. It is the reference wiring
  other sites copy, so its `lychee.toml` comments must match the released
  semantics.
- **[open-telemetry/opentelemetry.io][]**: `package.json` pin, the PR check
  workflow, the refresh workflow, and helper scripts under `scripts/lychee/`.
  The largest cache: verify its double-check flow against any change to
  failure-word recording.

For each bump PR:

1. Pin the new version, then run the repo's safe install and its link-check
   script once to let the tools rewrite the cache file (schema migrations land
   in this run).
2. Drop any flag the release removed: workflow runs fail loudly on unknown
   flags, so the CI result confirms the sweep.
3. Update the repo's own docs wherever they describe cache semantics.
4. Let the PR's link check run green before requesting review.

## After the release

- For each consumer with a refresh lane, confirm it is enabled and produced a PR
  at its next scheduled run; a disabled refresh lane is the one failure the
  tools can't signal until `max_cache_age` fires.
- Close the release's tracking issues and milestone, if any.

<!-- prettier-ignore-start -->
[chalin/docsy-starter]: https://github.com/chalin/docsy-starter
[`check.yaml`]: ../.github/workflows/check.yaml
[google/docsy]: https://github.com/google/docsy
[google/docsy-example]: https://github.com/google/docsy-example
[open-telemetry/opentelemetry.io]: https://github.com/open-telemetry/opentelemetry.io
[`publish.yaml`]: ../.github/workflows/publish.yaml
<!-- prettier-ignore-end -->
