# Security policy

VIGO is pre-release software and does not yet have a supported-version window.
The local HTTP API is intended for loopback use only; do not expose it directly
to an untrusted network.

The executable refuses non-loopback binding unless
`VIGO_UNSAFE_ALLOW_NON_LOOPBACK=1` is set, and it still rejects non-loopback
clients. GTFS-Realtime retrieval blocks private and special network addresses;
`VIGO_UNSAFE_ALLOW_PRIVATE_REALTIME=1` is a local-development escape hatch, not
a supported deployment boundary. Ordinary JSON requests are limited to 8 MB,
while GTFS and OSM source uploads use separately bounded streaming paths.

Before reporting a suspected vulnerability, confirm that it is reproducible in
the current `main` branch. Use GitHub private vulnerability reporting when it
is available for this repository. If that option is unavailable, open a brief
issue asking the maintainers for a private contact channel without including
exploit details, credentials, private paths, or private datasets.

Ordinary defects and non-sensitive hardening suggestions can use the public
issue tracker.
