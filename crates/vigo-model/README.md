# vigo-model

The public VIGO contract in Rust: every request the engine accepts and every Result it returns, as typed structs with their JSON Schema.

The types describe VIGO 1.0.0-rc.1 exactly. Reading a recorded Result into them and writing it back produces the same JSON, number forms included. The runtime now uses the typed headway estimate payload. Other public envelopes still use the existing JSON projection; the corpus round-trip checks guard that remaining boundary.

## What it contains

| Module | Types |
| --- | --- |
| `request` | `RouteRequest`, `MatrixRequest`, `ReachRequest`, `CompareRequest`, places, scenarios, realtime snapshots, traffic |
| `result` | `Response` (every document, keyed by `schema`), `RouteResult`, `MatrixResult`, `ReachResult`, `CompareResult`, `InfoResult`, `CollectionInfoResult`, `StreamDetail`, `ErrorResult` |
| `journey` | `Journey`, `Leg` (`walk`, `transit`, `drive`), endpoints, quality evidence, fares |
| `capabilities` | `Capabilities`, from `vigo capabilities` and `GET /v1/capabilities` |
| `common` | `Coordinate`, `Bounds`, `Identifier`, `Clock`, modes, `Maybe` |
| `number` | `Number`, a JSON number written without a fraction when it is integral |
| `schema` | The OpenAPI 3.1 document, generated from the types |
| `codegen` | TypeScript and Python types, generated from the OpenAPI components |

Three conventions carry the 1.0.0-rc.1 behavior:

- **Numbers.** `Number` writes `1200`, not `1200.0`, exactly as the engine does.
- **Absent, `null` and present.** An optional field is omitted rather than written as `null`. The few fields where VIGO uses all three states, such as a journey's `clockDate`, use `Maybe<T>`.
- **Strict requests.** Like the engine, requests reject unknown fields and `null` options.

Diagnostic output (`trace`, `memory`, `residency`, `/v1/native`) stays raw JSON. It is outside the stability policy.

## Generated files

`generated/` holds the OpenAPI document, `vigo.ts` and `vigo_types.py`. They are produced from the types; do not edit them.

```bash
cargo run -p vigo-model --bin vigo-model-gen
```

`cargo test` fails when they are stale. The TypeScript has no dependencies. The Python needs 3.11, or `typing_extensions` on 3.10.

## Tests

```bash
cargo test -p vigo-model
```

- `tests/corpus.rs` reads every record in [`test/corpus/recorded`](../../test/corpus/README.md) into the model and writes it back unchanged.
- `tests/schema.rs` validates the same records against the generated schema.
- `tests/generated.rs` checks the generated files are current.

To also cover the shapes the standalone checks produce, harvest them and point the tests at the records:

```bash
node test/corpus/corpus.mjs harvest --out /tmp/vigo-harvest
VIGO_CORPUS_EXTRA=/tmp/vigo-harvest/records cargo test -p vigo-model
```

[OPENAPI-DIFF.md](OPENAPI-DIFF.md) compares the generated OpenAPI with `docs/standalone-openapi.json`.
