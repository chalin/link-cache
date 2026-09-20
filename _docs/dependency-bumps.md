---
title: Dependency-bump review
description:
  Check a Renovate pull request before merging it, with the `gh` calls for
  release age, tag-to-commit, and ancestry.
---

[Renovate][] opens a pull request for each pin it moves; a maintainer reviews it
before merging. What the checks below establish, and why the pull requests
arrive as they do: [Supply-chain posture](supply-chain.md#dependency-bumps).

## Any bump

1. Read the whole diff, not the title. A bump touches only the files that hold
   the [pins Renovate manages](supply-chain.md#dependency-bumps).
2. Check that the new version is older than the cooldown in [`renovate.jsonc`][]
   (a security-alert fix is exempt and arrives early).
3. Let the pull request's checks finish green. If the diff rewrites a `uses:`
   line, continue below; otherwise merge.

## An action bump

The diff rewrites a `uses:` line's SHA and its `# vX.Y.Z` comment. With
_`OWNER/REPO`_ the action's repository, _`TAG`_ the version in the new comment,
and _`SHA`_ the new pin:

```sh
gh api repos/OWNER/REPO/releases/tags/TAG --jq '{published_at, prerelease, immutable}'
gh api repos/OWNER/REPO/commits/TAG --jq .sha
gh api repos/OWNER/REPO/compare/main...SHA --jq .status
```

1. The first call must return a release (a `Not Found` is the no-release case:
   stop), not a prerelease, published before the cooldown. `"immutable": true`
   means the tag cannot have moved since its release: the second check is moot.
2. The second call peels the tag to its commit; it must equal _`SHA`_. A
   mismatch means the tag moved after Renovate looked: don't merge this pull
   request; its replacement is described under `branchTopic` in the
   [posture section](supply-chain.md#dependency-bumps).
3. The third call must report `behind` or `identical`: the commit is an ancestor
   of the upstream's default branch. A backport lives on a release branch
   instead (`actions/checkout` v6.1.0 on `releases/v6`); compare
   `releases/vN...SHA` the same way. `ahead` or `diverged` against both is the
   shape of a moved tag pointing at code the upstream never merged: don't merge.
4. Same version, new SHA (a `digest` update): a released tag moved, which has no
   routine reason. List what changed between the old and new commits,
   `gh api repos/OWNER/REPO/compare/OLD_SHA...SHA --jq '.files[].filename'`, and
   stop on any change to `dist/`, `action.yml`, or a workflow that the release
   notes don't account for.

When every applicable check passes, merge.

<!-- prettier-ignore-start -->
[Renovate]: https://docs.renovatebot.com/
[`renovate.jsonc`]: ../renovate.jsonc
<!-- prettier-ignore-end -->
