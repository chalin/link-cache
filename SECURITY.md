# Security policy

Do not report vulnerabilities in public issues, discussions, or pull requests.

## Reporting

Use GitHub's [private vulnerability reporting][report]; fixes and disclosure go
through a GitHub security advisory. If a report goes unanswered, a public issue
saying only that a private report is pending is welcome.

## Supported versions

Fixes ship in the next release and are not backported. For how consumers receive
them, see the [release runbook](_docs/release.md#supported-versions).

## Scope

The CLIs run in consumers' CI with a GitHub token in the environment; anything
that could expose or misuse it is in scope. The package has no runtime
dependencies. Documented behavior over the operator's own arguments and cache
file is not a vulnerability.

## Verifying a release

Every version from 0.4.0 is published from this repository's GitHub Actions
workflow with npm provenance. `npm audit signatures` checks a registry-installed
copy's signature and attestations; a `github:` install has neither. For how the
workflow is protected, see [Supply-chain posture](_docs/supply-chain.md).

<!-- prettier-ignore-start -->
[report]: https://github.com/chalin/link-cache/security/advisories/new
<!-- prettier-ignore-end -->
