# Security policy

VIGO is pre-release software and does not yet publish a supported-version
window. The project is designed for local analysis on data the operator is
authorized to use; it is not a hosted service or a hardened multi-tenant
deployment.

## Safe operating boundary

- Keep the local HTTP API on its loopback bind address. Do not expose it to an
  untrusted network.
- Treat GTFS, OSM, GTFS-Realtime URLs, release archives, and generated stores as
  input data, not as trusted code.
- Keep credentials, private datasets, local paths, generated archives, and
  benchmark material out of issues and pull requests.
- The runtime and archive paths enforce bounded downloads/extraction where the
  code owns that boundary; those limits do not make arbitrary source files or
  third-party feeds trustworthy.

The executable rejects non-loopback binding unless the explicit development
escape hatch `VIGO_UNSAFE_ALLOW_NON_LOOPBACK=1` is set. That flag is not a
deployment recommendation. GTFS-Realtime retrieval applies URL and response
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
