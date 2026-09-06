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
   [GitHub-install example](../docs/cli.md#install-from-github)
   (`#semver:^`_`VERSION`_) in the same commit.
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
   act on.

## Tag and release

1. Tag the exact `main` commit verified in [Before tagging](#before-tagging),
   _`RELEASE_SHA`_: `git tag v`_`VERSION`_ _`RELEASE_SHA`_, then
   `git push origin v`_`VERSION`_.
2. Create the GitHub release from the tag, with notes: a one-line summary,
   behavior changes and any migration steps, then the merged PRs. Publishing it
   is the only trigger of [`publish.yaml`][].
3. Watch the [`publish.yaml`][] run: it refuses a tag that doesn't match
   `package.json`, then publishes.
4. Verify on npm: the version appears with a provenance badge,
   `npm view link-cache version` prints it, and the README's doc links on the
   package page resolve (npm rewrites them to this repo).

If the workflow fails:

1. Check whether the version reached npm with `npm view link-cache@`_`VERSION`_
   `version`. Publication can succeed before a lost response or a failing
   post-job step.
2. If the version is present, do not publish it again. Investigate the remaining
   workflow failure.
3. If the registry confirms the version is absent, re-run the failed job. A
   network or authentication error is not proof that the version is absent.
4. If recovery requires a code change, leave the tag and release in place (a
   GitHub install may already have resolved the tag). Fix on `main`, bump the
   patch version, release again, and point the earlier release's notes at its
   successor.

Never move or delete a tag.

## Consumer bumps

Each release is followed by bump PRs in the consumers the maintainer tends. A
consumer whose `.npmrc` sets a `min-release-age` cooldown rejects a version
younger than the cooldown ([Supply-chain posture](supply-chain.md)): open that
bump after the cooldown, or wait it out in the bump branch. The consumers, with
what a bump touches:

- **[google/docsy][]** (docsy.dev): exact pin in `docsy.dev/package.json`, 7-day
  cooldown; the PR check workflow, the scheduled refresh workflow, and the
  maintainer notes that describe the cache semantics.
- **[google/docsy-example][]**: exact pin, no cooldown; its check scripts; no
  refresh lane.
- **[chalin/docsy-starter][]**: caret range, 7-day cooldown. The reference
  wiring other sites copy, so its scripts and `lychee.toml` comments must match
  the released semantics.
- **[theupdateframework/theupdateframework.io][]**: caret range, no cooldown.
  Check its `engines.node` against this package's requirement before bumping.
  The bump goes in as an upstream PR.
- **[open-telemetry/opentelemetry.io][]**: exact pin, 7-day cooldown; the PR
  check workflow, the refresh workflow, and helper scripts under
  `scripts/lychee/`. The largest cache: verify its double-check flow against any
  change to failure-word recording.

For each bump PR:

1. Check that the dependency declaration admits the release: a caret range on a
   0.x version excludes the next minor. Update the manifest when needed and
   refresh the committed lockfile before running the safe install and link-check
   script (schema migrations land in the check run).
2. Drop any flag the release removed, in workflows and in `package.json`
   scripts. For verifying that arguments reach the checker, follow the
   [argument-forwarding guidance](../docs/cli.md#argument-forwarding).
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
