---
title: Supply-chain posture
---

The package ships link-checking bins that consumers run in CI with a GitHub
token in the environment, and its own publish workflow holds npm publish
authority. Both make this repo's dependency surface a target. The posture: keep
that surface as close to zero as possible, and make every remaining install
deterministic and script-free. This page is the home of the rationale; the
[`.npmrc`][] and the workflows carry the settings and point here. The shared
threat model behind the controls is the [OpenTelemetry website's supply-chain
page][otel-supply-chain].

## Zero runtime dependencies

The published CLIs depend on Node's standard library only. Prettier is the sole
dev dependency, used for formatting checks. Any proposal to add a dependency
carries the burden of proof; prefer a few dozen lines of code over a package.

## Committed lockfile, exact installs

`package-lock.json` is committed and is the only install path: `npm ci` (via
`npm run install:safe`) installs exactly what the lock resolves and fails when
the manifest's dependencies disagree with it, instead of resolving anew (it does
not compare other fields, such as `version`). Never run bare `npm install` in
this repo: it can rewrite the lock and pull newer versions.

## `.npmrc` controls

The committed [`.npmrc`][] applies to every install, local or CI. Two controls
are newer than the npm that Node 24.0 bundled; older versions warn about the
unknown key and skip it: `min-release-age` needs npm 11.10,
`strict-allow-scripts` npm 11.16.

- `min-release-age`: when npm resolves dependencies (a bump, an `npm update`), a
  version must have aged on the registry for the configured cooldown before it
  can enter the lockfile. Most malicious releases are pulled within days: the
  cooldown lets that happen first. `npm ci` installs whatever the lock already
  says, so the control guards lock updates, not CI installs.
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
  to full commit SHAs, with the version in a trailing comment for readability (a
  tag can be moved; a SHA cannot). [`check.yaml`][] still uses tag pins.
- The publish job installs nothing and runs `npm publish --ignore-scripts` (the
  flag repeats the `.npmrc` control at the one step that runs with publish
  authority, so it holds even if the file regresses). The check workflow runs on
  every pull request and on pushes to `main`, but nothing enforces it on the
  release commit: the [release runbook](release.md) makes a green `main` the
  precondition for tagging. Re-running an install under the job that holds the
  OIDC `id-token` would only let registry-delivered code run with publish
  authority.
- Publishing is by npm trusted publishing (OIDC from this repo's workflow):
  there is no long-lived token to leak, and every version this workflow
  publishes (0.4.0 onward) carries provenance linking it to the workflow run.

## The `npx` fallback

The `lychee-norm-cache` bin name was squatted on the npm registry in 2026,
before the package reached it. The fallback that made the squat dangerous is
described in the [CLI reference](../docs/cli.md). Consequences for this repo:

- Never wire bare `npx` in scripts, CI, or docs; use bare bin names in `npm run`
  scripts.
- Claim any new package or bin name on the npm registry before it appears in a
  public manifest or doc.

## Consumer-side controls

Consumers should pin the package version (the larger sites pin exactly), install
with `npm ci --ignore-scripts`, and give the link-check CI step only the
`GITHUB_TOKEN` it needs. The refresh lane's PR-opening step runs with `contents`
and `pull-requests` write permission: keep it in a separate job from the check
so the check itself runs read-only.

<!-- prettier-ignore-start -->
[`.npmrc`]: ../.npmrc
[`check.yaml`]: ../.github/workflows/check.yaml
[otel-supply-chain]: https://opentelemetry.io/site/design/supply-chain-security/
[`publish.yaml`]: ../.github/workflows/publish.yaml
<!-- prettier-ignore-end -->
