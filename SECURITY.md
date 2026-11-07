# Security policy

Security fixes go to the latest VIGO release; update to it before reporting.
VIGO is designed for analysis on data the operator is authorized to use. It is
not a hardened multi-tenant service. The optional
[public route planner](docs/guides/public-routing.md) exposes routing only,
through a restricted gateway.

## Safe operating boundary

- Keep the Studio API on its loopback bind address. Do not expose it to an
  untrusted network.
- Treat GTFS, OSM, GTFS-Realtime URLs, release archives, and generated stores as
  input data, not as trusted code.
- Keep credentials, private datasets, local paths, generated archives, and
  benchmark material out of issues and pull requests.
- The runtime and archive paths enforce bounded downloads/extraction where the
  code owns that boundary; those limits do not make arbitrary source files or
  third-party feeds trustworthy.

`vigo serve` rejects a non-loopback bind without a `VIGO_API_TOKEN` of at least
16 characters. The Studio API has no remote authentication and rejects
non-loopback binding unless the explicit development escape hatch
`VIGO_UNSAFE_ALLOW_NON_LOOPBACK=1` is set; that flag is not a deployment
recommendation. GTFS-Realtime retrieval applies URL and response
size/address checks; `VIGO_UNSAFE_ALLOW_PRIVATE_REALTIME=1` is likewise a
local-development escape hatch.

## Reporting a vulnerability

Use GitHub private vulnerability reporting for sensitive reports when it is
available for this repository. If it is unavailable, open a brief public issue
asking the maintainers for a private contact channel. Do not include exploit
details, credentials, private paths, private datasets, or proof-of-concept
payloads in that issue.

Include the affected version or revision, operating system, minimal safe
reproduction, expected behavior, observed behavior, and any logs with secrets
removed. Please do not publish a fix or public disclosure until the maintainer
has had a reasonable opportunity to investigate.

Ordinary defects, documentation errors, and non-sensitive hardening ideas can
use the public issue tracker. The [contribution guide](.github/CONTRIBUTING.md)
describes the supported verification lanes and repository boundaries.

See [resource limits](docs/guides/resource-limits.md) for bounded admission,
container-aware memory budgets, and explicit swap configuration.
