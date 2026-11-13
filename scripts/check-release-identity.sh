#!/usr/bin/env bash
# One version is one build: refuse to publish BUILD (build-<12 hex>) under TAG
# when TAG's release already holds files from any other build. Republishing
# the same build is allowed, so a failed upload can be retried.
set -euo pipefail
tag="$1" build="$2"
[[ "$build" =~ ^build-[0-9a-f]{12}$ ]] || { echo "::error::Not a build identifier: $build"; exit 1; }
if ! names="$(gh release view "$tag" --json assets --jq '.assets[].name' 2>/dev/null)"; then
  echo "$tag is unpublished; it will be $build."
  exit 0
fi
others="$( (grep -o 'build-[0-9a-f]\{12\}' <<<"$names" || true) | sort -u | grep -vx "$build" || true)"
if [[ -n "$others" ]]; then
  echo "::error::$tag is already published as $(paste -sd, - <<<"$others"). A version has exactly one build; release this commit under a new version (bump package.json and tag it)."
  exit 1
fi
echo "$tag holds only $build (or nothing yet)."
