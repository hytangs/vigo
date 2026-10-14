# Security policy

VIGO 0.3 is pre-release software. Do not use it for safety-critical, operational, or passenger-information systems without independent validation.

## Report a vulnerability

Please report vulnerabilities privately through the repository security advisory page. Include the affected version, platform, a minimal reproduction, and the impact. Do not include credentials or private transport data.

## Supported surface

Security support covers the current `vigo` Python package and its communication with a local VIGO 0.3 runtime. VIGO does not expose a public network service through this package.

The SDK accepts local City paths, local source paths during Build, and a caller-selected VIGO command. Applications remain responsible for controlling which files and commands untrusted users may select.
