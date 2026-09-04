# Command line and VIGO Python

The CLI is VIGO's shell and automation interface. VIGO Python is the programming interface for Python analysis, notebooks, and applications. Both use the same City, Scenario, Query, and Result model.

## Python

```python
import vigo

city = vigo.open("./city")
proposal = city.scenario("More service", services=changes)

route = city.run(vigo.Route(...))
matrix = city.run(vigo.Matrix(...))
reach = proposal.run(vigo.Reach(...))
comparison = vigo.compare(city.reach(...), reach)
```

`Context.run(query)` is canonical. The `route`, `matrix`, and `reach` methods are convenience constructors only.

Query objects can be stored and reused:

```python
query = vigo.Reach(
    origin,
    depart_at="08:00",
    service_date="2026-09-04",
)
results = city.run([query, query])
job = city.submit(query)
```

## Command line

```text
vigo build
vigo capabilities
vigo inspect
vigo route
vigo matrix
vigo reach
vigo compare
```

- `build` creates one City.
- `capabilities` reports API compatibility and supported combinations.
- `inspect` describes a selected City.
- `route`, `matrix`, and `reach` run the three Queries.
- `compare` compares two saved Results.

The command line does not expose internal setup or one command per routing variant.

## Result shape

Every Result carries:

```json
{
  "kind": "route | matrix | reach",
  "status": "ready | blocked",
  "query": {},
  "warnings": [],
  "timing": {},
  "result": {}
}
```

Matrix uses `rows` and Reach uses `surface` plus `contours`. The common fields keep Studio, Python, and command-line interpretation aligned.

Malformed Queries raise `InvalidQuery`; valid unsupported combinations raise `UnsupportedQuery`; execution failures raise `VigoError`. Jobs separately report `queued`, `running`, `ready`, `cancelled`, or `error`.
