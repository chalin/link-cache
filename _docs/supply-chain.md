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
workflows.

## Workflow lint

[`zizmor.yaml`][] runs [zizmor][] over `.github/workflows` in its pedantic
persona (the security audits plus its workflow-hygiene ones) and uploads the
results to the repository's Security tab.

- Runs on every pull request, on pushes to `main`, and weekly, the weekly run
  catching advisories published against already-pinned actions.
- The step passes whatever it finds; what blocks a merge is the `main` ruleset,
  which requires a zizmor and a CodeQL analysis and rejects a pull request whose
  changed lines carry a security alert of high or higher severity or an
  error-level alert (alerts elsewhere in the tree surface in the Security tab
  but don't block).
- The workflow calls the [OpenTelemetry shared workflow][otel-zizmor] at a
  pinned commit; that workflow pins the zizmor action, which pins the zizmor
  image by digest, so nothing in the chain moves until the pin here does.
- CI-only by design: the repo carries no tooling dependency for it. A local run
  when needed is `uvx zizmor@`_`VERSION`_` .github/workflows`, where _`VERSION`_
  is the zizmor release the shared workflow currently pins.
- The job's `security-events: write` grant sits alone in its workflow, away from
  the jobs that install or publish.

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

## Dependency bumps

[Renovate][] (the Mend-hosted GitHub app) opens the pull requests that move this
repository's pins:

- The `uses:` refs in `.github/workflows/`: two actions, `actions/checkout` and
  `actions/setup-node`, and the reusable zizmor workflow from
  `open-telemetry/shared-workflows`. Renovate rewrites each ref's SHA and its
  `# vX.Y.Z` comment together.
- The dev dependencies in `package.json`
- The Node version in `.nvmrc`

[`renovate.jsonc`][] limits Renovate to those three managers, sets the schedule
on which it opens pull requests, and sets a [minimum release age][renovate-age]:
the cooldown a version must have passed before Renovate proposes it (Renovate's
default exempts a fix for a security alert). It complements `.npmrc`'s
`min-release-age`, which gates what npm resolves and so reaches neither actions
nor Node.

A maintainer reviews every Renovate pull request before merging it; there is no
automerge. For an action bump, the review establishes that the commit the pull
request pins is the one the version's release names, and that the release has
aged. The checks, with their `gh` calls:
[Dependency-bump review](dependency-bumps.md).

When a pin has not moved, look in three places. The Dependency Dashboard issue
Renovate keeps in the repository lists the updates it has found but not yet
proposed. A version whose tag has no GitHub release is never a candidate (a
release deleted after Renovate saw it can linger in its cache for up to 30
days). And the config does nothing until the repository owner enables the
repository in the [Mend Renovate app][renovate-app], a one-time step whose
absence looks exactly like silence.

Two settings in the action rule exist because an action's version is a git tag,
which can be moved to another commit at any time:

- `overrideDatasource: github-releases`: Renovate's default lookup admits tags
  that have no release, dated by whoever pushed the tag. Under this setting,
  Renovate considers only versions with a [GitHub release][renovate-releases],
  dated by the release's publication time, which GitHub sets.
- `branchTopic` with the proposed SHA: a released tag can be moved after its
  release is old enough to pass the cooldown, and Renovate would then propose
  the new commit as if it were the aged release. With the SHA in the branch
  name, a moved tag produces a new pull request (Renovate closes the old one if
  nobody has pushed to it) instead of a silent change to an open one. The
  setting makes a changed target visible; the review's tag comparison is what
  notices it, and a same-version SHA change is investigated, since matching
  today's tag says nothing about the commit's age. Together, the setting and the
  review bound what a moved tag can do; a compromised upstream that publishes a
  proper release and waits is the cooldown's problem, and beyond it, the
  reviewer's.

The rule matches action and reusable-workflow refs only; runner labels
(`runs-on: ubuntu-latest`) have no GitHub releases and keep Renovate's default
lookup.

A bump pull request's own CI runs the proposed commit before any maintainer
looks at it: an action in the `check` job of [`check.yaml`][], the shared
workflow in the `zizmor` job of [`zizmor.yaml`][]. Those jobs hold
`contents: read` (the zizmor job also `security-events: write`) and no publish
authority; publishing is the [release runbook](release.md)'s procedure, from a
reviewed `main` commit.

## Pinned actions, protected refs, and a script-free publish

- Actions in [`check.yaml`][] and [`publish.yaml`][] are pinned to full commit
  SHAs, with the version in a trailing comment for readability (a tag can be
  moved; a SHA cannot). How the pins move:
  [Dependency bumps](#dependency-bumps).
- A repository ruleset on `main` blocks deletion and force-pushes, requires a
  linear history, and requires a passing `check` run plus the code-scanning
  results described under [Workflow lint](#workflow-lint) before the branch
  moves.
- A ruleset on `v*` tags blocks moving and deleting them, and immutable releases
  freeze a release's tag and assets once published, so a `github:` install
  pinned to a tag keeps resolving to the code that was reviewed. Neither rule
  ties a tag to `main`, so the publish job checks that itself: it refuses a
  release whose commit is not in `main`'s history, which is the history the
  ruleset guards.
- The publish job skips a release marked as a pre-release on GitHub: a stable
  version published that way would land on npm's default dist-tag, `latest`,
  which is what a plain `npm install link-cache` resolves.
- The publish job installs nothing and runs `npm publish --ignore-scripts`: an
  install under the job that holds the OIDC `id-token` would let
  registry-delivered code run with publish authority.
- No job restores a package-manager cache (a `setup-node` default); the check
  job's one dependency downloads in seconds.
- No job keeps the checkout's token past the checkout step.
- Publishing is by npm trusted publishing (OIDC from this repo's workflow):
  there is no long-lived token to leak, and every version this workflow
  publishes (0.4.0 onward) carries provenance linking it to the workflow run.
- The publish job sets no `registry-url`: that `setup-node` input exists for
  token auth, and npm exchanges the OIDC token at its default registry.

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
[otel-zizmor]: https://github.com/open-telemetry/shared-workflows/blob/main/zizmor/README.md
[`publish.yaml`]: ../.github/workflows/publish.yaml
[Renovate]: https://docs.renovatebot.com/
[renovate-age]: https://docs.renovatebot.com/key-concepts/minimum-release-age/
[renovate-app]: https://docs.renovatebot.com/getting-started/installing-onboarding/#hosted-githubcom-app
[renovate-releases]: https://docs.renovatebot.com/modules/datasource/github-releases/
[`renovate.jsonc`]: ../renovate.jsonc
[zizmor]: https://docs.zizmor.sh/
[`zizmor.yaml`]: ../.github/workflows/zizmor.yaml
<!-- prettier-ignore-end -->
