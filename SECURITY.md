# Security policy

Do not report vulnerabilities in public issues, discussions, or pull requests.

## Reporting

Use GitHub's [private vulnerability reporting][report]; fixes and disclosure go
through a GitHub security advisory. If you cannot use GitHub, email
<pchalin@gmail.com>.

## Supported versions

For supported versions and how fixes reach consumers, see the
[release runbook](_docs/release.md#supported-versions).

## Scope

Anything in this package is in scope. The high-impact case: the CLIs run in
consumers' CI with a GitHub token in the environment, which `lychee-norm-cache`
passes on to lychee; defects in lychee itself belong upstream. The published
package depends on no npm packages. Documented behavior whose effects stay
within the operator's own arguments and cache file is not a vulnerability.

## Verifying a release

`npm audit signatures` checks that a registry-installed copy's signature and
provenance attestation are valid; it does not check which repository the
attestation names, and a `github:` install has neither. For which versions carry
provenance and how the workflow is protected, see
[Supply-chain posture](_docs/supply-chain.md).

<!-- prettier-ignore-start -->
[report]: https://github.com/chalin/link-cache/security/advisories/new
<!-- prettier-ignore-end -->
