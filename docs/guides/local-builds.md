# Keep local builds clear

Use the package version, source revision and checksum together to identify a
local build. Development builds can share a version number while containing
different code. The version in `package.json` does not make a local build a
published release; [release notes](../releases/0.4.4.md) retain that history.

## Choose the current build

Keep one clearly identified Studio application and archive for each platform
in the active release directory. Record the source revision beside the archive
and verify its SHA-256 checksum before extraction. For example, on macOS:

```sh
shasum -a 256 VIGO-Studio-VERSION-mac-arm64.zip
```

Replace `VERSION` with the version in the filename. An extracted application
with that same version label may still belong to an earlier build. Compare its
recorded runtime identity with the selected archive before making it the active
copy. Do not replace or move a running or installed application as part of
routine archive cleanup.

Keep independently built Engine packages separate from Studio. When a package
manifest records a dirty source tree, preserve that distinction; a matching
version or parent commit does not make it identical to a clean source build.

## Archive with rollback

Move obsolete install copies and duplicate archives into a dated archive
outside the active release directory. Keep checksums beside their archives.
Record each item's original path, archived path, version, source revision when
known, and checksum in a local manifest. Record the bundled runtime identities
for application directories. Preserve files and metadata rather than deleting
them, and never overwrite an existing archive destination.

Keep the manifest with the archive and leave a short pointer beside the current
build. Local manifests and package archives belong outside the public source
tree or in ignored build-output directories.

Frozen research runtimes, benchmark inputs and results, original graphs,
papers, credentials, application data and user projects retain their recorded
locations. An older filename alone is not a reason to move those files. Trace
imports and build scripts before treating a source entrypoint as obsolete.

To restore an archived copy, first preserve any replacement at its original
path. Move the archived item back, verify its recorded identity, and keep the
manifest as the rollback record. Do not overwrite a destination changed since
cleanup.

For building and installing Studio, see [Studio](studio.md). For supported
checks and package verification, see [Contributing](../../.github/CONTRIBUTING.md).
