# Security policy

Please do not report vulnerabilities in public issues, discussions, or pull
requests.

## Reporting

Use GitHub's [private vulnerability reporting][report] for this repository.
Expect an acknowledgement within 3 days; fixes and disclosure go through a
GitHub security advisory.

## Supported versions

The latest release only; fixes are not backported.

## Scope

The package has no runtime dependencies, so there is nothing to report upstream.
Behavior the docs describe as intentional is not a vulnerability: for example,
`--match` takes a regex the operator writes and applies it to their own cache.

## Verifying a release

Every version from 0.4.0 is published from this repository's GitHub Actions
workflow with npm provenance; `npm audit signatures` verifies an installed copy
against the registry's attestations. How the workflow is protected:
[Supply-chain posture](_docs/supply-chain.md).

<!-- prettier-ignore-start -->
[report]: https://github.com/chalin/link-cache/security/advisories/new
<!-- prettier-ignore-end -->
