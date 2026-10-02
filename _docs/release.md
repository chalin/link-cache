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
   tag, not after), and the checks its ruleset requires are green on its head
   (which and why: [Supply-chain posture][posture-pinned]).
2. `package.json` `version` is the release version, _`VERSION`_ below. If a bump
   is needed, land it in its own commit with `npm version` _`VERSION`_
   `--no-git-tag-version`, which moves the lockfile's copy too, and update the
   [GitHub-install example](../docs/cli.md#install-from-github)
   (`#semver:^`_`VERSION`_) in the same commit.
3. Locally, from a clean, up-to-date checkout of `main`:

   ```sh
   npm run install:safe
   npm run check
   npm pack --dry-run
   ```

   Read the pack listing against `files` in `package.json`: only the bins and
   their `lib/` modules ship, plus the manifest, README, and license that npm
   always includes. Keep the shasum it prints:
   [Tag and release](#tag-and-release) step 4 compares against it.

4. Review the diff since the previous tag for behavior changes consumers must
   act on, and draft the release notes in `tmp/`: a one-line summary, then
   behavior changes and any migration steps (GitHub appends the merged-PR list).
   Link docs at the tag ref (`blob/v`_`VERSION`_`/…`), so the notes keep
   pointing at the released text.
5. The registry does not hold the version yet: `npm view link-cache@`_`VERSION`_
   `version` reports E404. A hit means the version is already taken: back to
   step 2. The failure branch below also relies on this baseline.

## Tag and release

1. Tag the exact `main` commit verified in [Before tagging](#before-tagging),
   _`RELEASE_SHA`_, push the tag, and confirm that the remote tag resolves to
   it:

   ```sh
   git tag vVERSION RELEASE_SHA
   git push origin vVERSION
   gh api repos/chalin/link-cache/commits/vVERSION --jq .sha
   ```

   The last command must print _`RELEASE_SHA`_. On a mismatch, stop here: the
   tag can't move, so bump the version and start over. The tag must exist before
   step 2 creates the release: with immutable releases on, the release API
   rejects a missing tag.

2. Create the GitHub release from the tag, with _`NOTES_FILE`_ the reviewed
   draft from [Before tagging](#before-tagging), step 4:

   ```sh
   gh release create vVERSION --verify-tag --title vVERSION --notes-file tmp/NOTES_FILE --generate-notes
   ```

   Don't pass `--prerelease` (why: [Supply-chain posture](supply-chain.md)). The
   command publishes the release, the only trigger of [`publish.yaml`][].

3. Watch the [`publish.yaml`][] run: it refuses a commit off `main` or a tag
   that doesn't match `package.json`, then publishes.
4. Verify on npm. The registry lags the publish by a few minutes (`npm publish`
   says so in its last lines): until then `npm view` reports E404 for the
   version, and `latest` still names the previous one. Once it catches up:
   - `npm view link-cache version dist-tags dist.shasum dist.attestations`
     prints the version as `latest`, the shasum from the pack listing, and
     `dist.attestations` with a `provenance` entry (its URL alone could be a
     mere publish signature).
   - The README's doc links on the package page resolve. The page refuses
     non-browser clients, so check it in a browser; the scriptable half is that
     every relative link in `npm view link-cache readme` has its target on
     `main` (the link's `blob/HEAD/` form returns 200), since npm rewrites those
     links against the repository's default branch.

If the workflow fails:

1. Check whether the version reached npm (publication can succeed before a lost
   response or a failing post-job step):
   - A `+ link-cache@`_`VERSION`_ line in the publish step's log means the
     registry accepted the version, whatever `npm view` says during the lag
     above.
   - Without that line, re-check `npm view link-cache@`_`VERSION`_ `version` for
     a few minutes before reading E404 as absent.
2. If the version is present, do not publish it again. Investigate the remaining
   workflow failure.
3. If the registry confirms the version is absent, re-run the failed job. A
   network or authentication error is not proof that the version is absent.
4. If recovery requires a code change, leave the tag and release in place (a
   GitHub install may already have resolved the tag). Fix on `main`, bump the
   patch version, release again, and point the earlier release's notes at its
   successor.

Never move or delete a release tag; the repository rejects both for `v*` tags
(why: [Supply-chain posture](supply-chain.md)).

## Supported versions

Fixes, security fixes included, land on `main` and ship as the next release;
nothing is backported to an earlier version. A consumer receives a fix when its
lockfile is refreshed: through its bump PR (next section) for an exact pin, or
through `npm update` or that same PR for a caret range that admits the release.

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
[google/docsy]: https://github.com/google/docsy
[google/docsy-example]: https://github.com/google/docsy-example
[open-telemetry/opentelemetry.io]: https://github.com/open-telemetry/opentelemetry.io
[posture-pinned]: supply-chain.md#pinned-actions-protected-refs-and-a-script-free-publish
[`publish.yaml`]: ../.github/workflows/publish.yaml
[theupdateframework/theupdateframework.io]: https://github.com/theupdateframework/theupdateframework.io
<!-- prettier-ignore-end -->
