# Maintainer docs

For whoever maintains this repository: how its controls are reasoned, and the
procedures that depend on them.

- [Supply-chain posture](supply-chain.md): the rationale home for every control
  in the repository, from the development setup and `.npmrc` gates to pinned
  actions, dependency bumps, and the script-free publish.
- [Release runbook](release.md): how a version reaches npm, and the consumer
  bumps that follow.
- [Dependency-bump review](dependency-bumps.md): what to check on a Renovate
  pull request before merging it, with the `gh` calls.

User docs are under [`docs/`](../docs/README.md); the security policy is
[`SECURITY.md`](../SECURITY.md).
