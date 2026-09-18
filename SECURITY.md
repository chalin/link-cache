# Security policy

Do not report vulnerabilities in public issues, discussions, or pull requests.

## Reporting

Use GitHub's [private vulnerability reporting][report]; fixes and disclosure go
through a GitHub security advisory. If a report goes unanswered, a public issue
saying only that a private report is pending is welcome.

## Supported versions

For supported versions and how fixes reach consumers, see the
[release runbook](_docs/release.md#supported-versions).

## Scope

The CLIs run in consumers' CI with a GitHub token in the environment, which
`lychee-norm-cache` passes on to lychee: report anything in this package that
could expose or misuse it; defects in lychee itself belong upstream. The package
has no npm dependencies. Documented behavior whose effects stay within the
operator's own arguments and cache file is not a vulnerability.

## Verifying a release

`npm audit signatures` checks that a registry-installed copy's signature and
provenance attestation are valid; it does not check which repository the
attestation names, and a `github:` install has neither. For which versions carry
provenance and how the workflow is protected, see
[Supply-chain posture](_docs/supply-chain.md).

<!-- prettier-ignore-start -->
[report]: https://github.com/chalin/link-cache/security/advisories/new
<!-- prettier-ignore-end -->
