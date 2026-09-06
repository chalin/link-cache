---
title: Release runbook
---

How a `link-cache` version reaches npm, and what follows in the consuming sites.
For why the publish workflow is shaped as it is, see
[Supply-chain posture](supply-chain.md). One-time setup, already done for this
package: on npmjs.com, the package's Settings > Trusted Publisher names this
repo and [`publish.yaml`][] as the publisher.

## Before tagging

1. `main` holds everything meant for the release (docs and code land before the
   tag, not after), and its head's [`check.yaml`][] run is green. This is the
   gate (why: [Supply-chain posture](supply-chain.md)).
2. `package.json` `version` is the release version, _`VERSION`_ below. If a bump
   is needed, land it in its own commit with `npm version` _`VERSION`_
   `--no-git-tag-version`, which moves the lockfile's copy too, and update the
   README's GitHub-install line (`#semver:^`_`VERSION`_) in the same commit.
3. Locally, from a clean checkout of `main`:

   ```sh
   npm run install:safe
   npm run check
   npm pack --dry-run
   ```

   Read the pack listing against `files` in `package.json`: only the bins and
   their `lib/` modules ship, plus the manifest, README, and license that npm
   always includes.

4. Review the diff since the previous tag for behavior changes consumers must
   act on: they become the release notes.

## Tag and release

1. Tag the merge commit, _`MERGE_SHA`_: `git tag v`_`VERSION`_ _`MERGE_SHA`_,
   then `git push origin v`_`VERSION`_.
2. Create the GitHub release from the tag, with notes: a one-line summary,
   behavior changes and any migration steps, then the merged PRs. Publishing it
   is the only trigger of [`publish.yaml`][].
3. Watch the [`publish.yaml`][] run: it refuses a tag that doesn't match
   `package.json`, then publishes with no install step.
4. Verify on npm: the version appears with a provenance badge,
   `npm view link-cache version` prints it, and the README's doc links on the
   package page resolve (npm rewrites them to this repo).

If the workflow fails, first check whether the version reached npm anyway
(`npm view link-cache@`_`VERSION`_ `version`: a publish can succeed before a
lost response or a failing later step); if it did not, re-run the failed job. If
the failure needs a code fix, leave the tag and release in place (a GitHub
install may already have resolved the tag), fix on `main`, bump the patch
version, release again, and point the orphaned release's notes at its successor.
Never move or delete a tag.

## Consumer bumps

Each release is followed by bump PRs in the consumers the maintainer tends
(other sites depend on the package too and bump on their own schedule). A
consumer whose `.npmrc` sets a `min-release-age` cooldown rejects a version
younger than the cooldown ([Supply-chain posture](supply-chain.md)): open that
bump after the cooldown, or wait it out in the bump branch. The consumers, with
what a bump touches:

- **[google/docsy][]** (docsy.dev): exact pin in `docsy.dev/package.json`, 7-day
  cooldown; the PR check workflow, the scheduled refresh workflow, and the
  maintainer notes that describe the cache semantics.
- **[google/docsy-example][]**: exact pin, no cooldown; its check scripts; no
  refresh lane.
- **[chalin/docsy-starter][]**: caret range (`^0.5.0`, which excludes 0.6.0, so
  the manifest changes too), 7-day cooldown. The reference wiring other sites
  copy, so its scripts and `lychee.toml` comments must match the released
  semantics.
- **[theupdateframework/theupdateframework.io][]**: caret range (`^0.3.0`), no
  cooldown, and an `engines.node` of 22 against this package's `>=24`; a
  contributor repo, so the bump goes in as an upstream PR.
- **[open-telemetry/opentelemetry.io][]**: exact pin, 7-day cooldown; the PR
  check workflow, the refresh workflow, and helper scripts under
  `scripts/lychee/`. The largest cache: verify its double-check flow against any
  change to failure-word recording.

For each bump PR:

1. Bump the manifest and refresh the committed lockfile together (a
   manifest-only change fails the consumers' `npm ci`), then run the safe
   install and the link-check script once to let the tools rewrite the cache
   file (schema migrations land in this run).
2. Drop any flag the release removed, in workflows and in `package.json`
   scripts: workflow runs fail loudly on unknown flags, local scripts don't.
3. Update the repo's own docs wherever they describe cache semantics.
4. Let the PR's link check run green before requesting review.

## After the release

- For each consumer with a refresh lane, confirm it is enabled and produced a PR
  at its next scheduled run (why it matters:
  [Operating model](../docs/operating-model.md#max_cache_age-the-last-resort-net)).
- Close the release's tracking issues and milestone, if any.

<!-- prettier-ignore-start -->
[chalin/docsy-starter]: https://github.com/chalin/docsy-starter
[`check.yaml`]: ../.github/workflows/check.yaml
[google/docsy]: https://github.com/google/docsy
[google/docsy-example]: https://github.com/google/docsy-example
[open-telemetry/opentelemetry.io]: https://github.com/open-telemetry/opentelemetry.io
[`publish.yaml`]: ../.github/workflows/publish.yaml
[theupdateframework/theupdateframework.io]: https://github.com/theupdateframework/theupdateframework.io
<!-- prettier-ignore-end -->
