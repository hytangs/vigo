# Golden corpus

Public requests and the Results VIGO returns for them, recorded from the `vigo` executable. Every later change replays them. A difference outside the declared varying fields is either a bug or a deliberate fix to record.

## Contents

- `cases.mjs` defines the Cities and the requests.
  - Every City is built from the public synthetic fixture (`test/helpers/cli-fixture-inputs.mjs`), sometimes with an edited feed. One is extracted from the frozen 0.5.0 archive.
  - The Cities cover walking, driving, wheelchair, private endpoint access, platform areas, fares, display metadata, station pathways, estimated stair costs, scoped feeds and a scenario collection.
- `recorded/` holds one file per case: the request, the exit code and the normalized Result. Error Results (`vigo.error.v1`) are recorded like any other.
- `corpus.mjs` builds the Cities, runs the requests, and records or compares.

## Commands

Build the compiler and engine first (`npm run build:cli-runtime`, `npm run build:standalone`), or let `npm run check:corpus` do it.

```bash
node test/corpus/corpus.mjs check                  # replay; fail on any difference
node test/corpus/corpus.mjs record                 # rewrite recorded/ from the executable
node test/corpus/corpus.mjs check --only standard  # one City, or one City/case
node test/corpus/corpus.mjs check --binary /path/to/vigo
```

Record only when a change in output is intended, and review the diff of `recorded/` like code.

`harvest` runs the standalone checks through a recording shim and saves every one-shot command they issue, in the same format. Use it to find Result shapes the corpus misses. Harvested Cities are temporary, so harvested records cannot be replayed:

```bash
node test/corpus/corpus.mjs harvest --out /tmp/vigo-harvest
VIGO_CORPUS_EXTRA=/tmp/vigo-harvest/records cargo test -p vigo-model
```

## Normalization

These fields differ between runs or builds. Each is replaced by a fixed value of the same type, so a normalized Result remains valid:

| Field | Why it varies |
| --- | --- |
| `meta.requestId` | Generated unless the request has an `id` |
| `meta.computeUs`, `profile.timingsUs.*` | Measured time |
| `meta.cityRevision`, `revision`, `cityRevisions.*` | Build time of the City |
| `meta.queryFingerprint` | Hashes the City revision |
| `meta.realtimeSnapshotFingerprint` | Hashes a snapshot stamped at run time |
| `memory` anywhere | Process memory |
| `trace` | Unstable internal ABI; only its presence is compared |

Realtime snapshots and traffic expire, so those requests are stamped at run time and recorded with a fixed timestamp. All other fields, including geometry, clocks, durations and error messages, must match exactly.

The Rust model tests (`crates/vigo-model`) read every file here and write it back unchanged, and validate it against the generated schema.
