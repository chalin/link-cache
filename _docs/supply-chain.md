---
title: Supply-chain posture
---

The package ships link-checking bins that consumers run in CI with a GitHub
token in the environment, and its own publish workflow holds npm publish
authority. Both make this repo's dependency surface a target. The posture: keep
that surface as close to zero as possible, and make every remaining install
deterministic and script-free.

## Zero runtime dependencies

The published CLIs depend on Node's standard library only. Prettier is the sole
dev dependency, used for formatting checks. Any proposal to add a dependency
carries the burden of proof; prefer a few dozen lines of code over a package.

## Committed lockfile, exact installs

`package-lock.json` is committed and is the only install path: `npm ci` (via
`npm run install:safe`) fails on any manifest/lock mismatch instead of resolving
anew. Never run bare `npm install` in this repo; it can rewrite the lock and
pull newer versions.

## `.npmrc` controls

The committed `.npmrc` applies to every install, local or CI:

- `min-release-age`: a version must have aged on the registry before npm will
  install it. Most malicious releases are pulled within days; the cooldown lets
  that happen before the version can reach us, so bumps wait it out.
- `ignore-scripts` and `strict-allow-scripts`: lifecycle scripts (`preinstall`,
  `postinstall`, ...) never run. No dependency here needs them. `install:safe`
  repeats `--ignore-scripts` explicitly so the control survives an `.npmrc`
  regression.
- `engine-strict`: the `engines` field is enforced, so an unsupported Node fails
  at install time rather than at first run.
- `script-shell`: one interpreter for npm scripts on every platform (npm on
  Windows defaults to `cmd.exe`, whose quoting diverges silently).

## Pinned actions and a script-free publish

- Actions in [`publish.yaml`][], the workflow with publish authority, are pinned
  to full commit SHAs, with the version in a trailing comment for readability; a
  tag can be moved; a SHA cannot. The check workflow still uses tag pins.
- The publish job installs nothing and runs `npm publish --ignore-scripts`. The
  check workflow gates pushes to `main` and every pull request, so the release
  commit has already passed `npm run check`; re-running an install under the job
  that holds the OIDC `id-token` would only let registry-delivered code run with
  publish authority.
- Publishing is by npm trusted publishing (OIDC from this repo's workflow):
  there is no long-lived token to leak, and every published version carries
  provenance linking it to the workflow run.

## The `npx` fallback

The `lychee-norm-cache` bin name was squatted on the npm registry in 2026,
before the package reached it; the fallback that made the squat dangerous is
described in the [CLI reference](../docs/cli.md). Consequences for this repo:

- Never wire bare `npx` in scripts, CI, or docs; use bare bin names in `npm run`
  scripts.
- Claim any new package or bin name on the npm registry before it appears in a
  public manifest or doc.

## Consumer-side controls

Consumers should pin the package version (the larger sites pin exactly), install
with `npm ci --ignore-scripts`, and give the link-check CI step only the
`GITHUB_TOKEN` it needs. The refresh lane's PR-opening step runs with `contents`
and `pull-requests` write permission; keep it in a separate job from the check
so the check itself runs read-only.

<!-- prettier-ignore-start -->
[`publish.yaml`]: ../.github/workflows/publish.yaml
<!-- prettier-ignore-end -->
