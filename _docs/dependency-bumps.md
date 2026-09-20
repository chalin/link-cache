---
title: Dependency-bump review
description:
  Check a Renovate pull request before merging it, with the `gh` calls for
  release age, tag-to-commit, and ancestry.
---

For why the bumps arrive as they do, see
[Supply-chain posture](supply-chain.md#dependency-bumps).

## Any bump

1. Read the whole diff, not the title: a bump touches manifests, lockfiles, and
   workflow `uses:` lines, nothing else.
2. Check that the new version is older than the cooldown in [`renovate.jsonc`][]
   (a security-alert fix is exempt and arrives early).
3. Let the pull request's checks finish green, then merge.

## An action bump

The diff rewrites a `uses:` line's SHA and its `# vX.Y.Z` comment. With
_`OWNER/REPO`_ the action's repository, _`TAG`_ the version in the new comment,
and _`SHA`_ the new pin:

```sh
gh api repos/OWNER/REPO/releases/tags/TAG --jq '{published_at, prerelease, immutable}'
gh api repos/OWNER/REPO/commits/TAG --jq .sha
gh api repos/OWNER/REPO/compare/SHA...main --jq .status
```

1. The first call must return a release (a tag with no release is not a
   candidate; it is a reason to stop), not a prerelease, published before the
   cooldown. `"immutable": true` means the tag cannot have moved since: the
   remaining checks are moot.
2. The second call peels the tag to its commit; it must equal _`SHA`_. A
   mismatch means the tag moved after Renovate looked; expect Renovate to close
   this pull request and open another for the new commit.
3. The third call must report `behind` or `identical`: the commit is an ancestor
   of the upstream's default branch. A backport lives on a release branch
   instead (`actions/checkout` v6.1.0 on `releases/v6`); compare against that
   branch. `diverged` against both is the shape of a moved tag pointing at code
   the upstream never merged: don't merge.
4. Same version, new SHA (a `digest` update): a released tag moved, which has no
   routine reason. Compare the old and new commits
   (`gh api repos/OWNER/REPO/compare/OLD_SHA...SHA`) and stop on any change to
   `dist/`, `action.yml`, or a workflow that the release notes don't account
   for.

These checks bound what a moved tag can do, not what a compromised upstream that
publishes a proper release can do; the cooldown is the control for that.

<!-- prettier-ignore-start -->
[Renovate]: https://docs.renovatebot.com/
[`renovate.jsonc`]: ../renovate.jsonc
<!-- prettier-ignore-end -->
