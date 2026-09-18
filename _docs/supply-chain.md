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

## Development

From the repository root:

```sh
npm run install:safe
npm run check
```

Tests use Node's built-in test runner and need neither network access nor the
Lychee binary. `.nvmrc` pins the Node version for `nvm use` and for both
workflows, one home for the CI toolchain line.

## Workflow lint

`npm run check` includes `check:workflows`, a [zizmor][] pass over
`.github/workflows` (unpinned actions, persisted credentials, cache poisoning,
template injection, and the rest of its default audits). It runs locally before
a push and again in CI, so a workflow edit cannot land unlinted. zizmor is not
an npm package, so the script runs it through `uvx` at an exact version, the one
committed exec of a non-npm tool in this repo: the pin is the control, and a
bump is reviewed like a dependency and waits out the same seven-day cooldown as
the `.npmrc` sets for npm. The check workflow installs `uv` (SHA-pinned action,
pinned `uv` version, cache off) because the runner image lacks it; the publish
job never runs the lint and never installs `uv`.

## Zero runtime dependencies

The published CLIs depend on Node's standard library only. Prettier is the sole
dev dependency, used for formatting checks. Any proposal to add a dependency
carries the burden of proof; prefer a few dozen lines of code over a package.

## Committed lockfile, exact installs

`package-lock.json` is committed and is the only install path: `npm ci` (via
`npm run install:safe`) installs exactly what the lock resolves and fails when
the manifest's dependencies disagree with it, instead of resolving anew. Never
run bare `npm install` in this repo: it can rewrite the lock and pull newer
versions.

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
  and the publish step repeat `--ignore-scripts` explicitly so the control
  survives an `.npmrc` regression where it matters most.
- `engine-strict`: the `engines` field is enforced, so an unsupported Node fails
  at install time rather than at first run.
- `script-shell`: one interpreter for npm scripts on every platform (npm on
  Windows defaults to `cmd.exe`, whose quoting diverges silently).

## Pinned actions and a script-free publish

- Actions in [`check.yaml`][] and [`publish.yaml`][] are pinned to full commit
  SHAs, with the version in a trailing comment for readability (a tag can be
  moved; a SHA cannot).
- The publish job skips a release marked as a pre-release: `npm publish` puts
  every version it publishes on the default dist-tag, `latest`, which is what a
  plain `npm install link-cache` resolves.
- The publish job installs nothing and runs `npm publish --ignore-scripts`: an
  install under the job that holds the OIDC `id-token` would let
  registry-delivered code run with publish authority. For the same reason it
  restores no package-manager cache (a `setup-node` default) and neither job
  keeps the checkout's token past the checkout step. A repository ruleset on
  `main` requires the check workflow to pass before a pull request can merge and
  rejects direct pushes, so every `main` commit, including the one a release
  tags, has passed it; the [release runbook](release.md) still reads the head's
  run before tagging.
- Publishing is by npm trusted publishing (OIDC from this repo's workflow):
  there is no long-lived token to leak, and every version this workflow
  publishes (0.4.0 onward) carries provenance linking it to the workflow run.

## The `npx` fallback

The `lychee-norm-cache` bin name was squatted on the npm registry in 2026,
before the package reached it. The fallback that made the squat dangerous is
described in the [CLI guide](../docs/cli.md). Consequences for this repo:

- Never wire bare `npx` in scripts, CI, or docs; use bare bin names in `npm run`
  scripts.
- Claim any new package or bin name on the npm registry before it appears in a
  public manifest or doc.

## Consumer-side controls

Consumers should pin the package version (the larger sites pin exactly); the
CI-side controls (least-privilege token, script-free install, a separate job for
the refresh lane's PR step) are in the user docs'
[Operating model](../docs/operating-model.md#two-lanes).

<!-- prettier-ignore-start -->
[`.npmrc`]: ../.npmrc
[`check.yaml`]: ../.github/workflows/check.yaml
[otel-supply-chain]: https://opentelemetry.io/site/design/supply-chain-security/
[`publish.yaml`]: ../.github/workflows/publish.yaml
[zizmor]: https://docs.zizmor.sh/
<!-- prettier-ignore-end -->
