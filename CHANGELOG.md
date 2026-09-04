# Version history

## 0.3.0

VIGO 0.3 establishes one product model:

```text
GTFS + OSM -> City -> Scenario -> Route | Matrix | Reach -> Result
```

- A City is one complete, movable directory. Building publishes it atomically.
- Route, Matrix, and Reach are the only public computation families.
- Scenario holds transport changes; walking limits and times remain Query inputs.
- Compare acts on completed Results.
- Studio, Python, and the command line use the same names and meanings.
- The Python package is `vigo` and contains no second routing implementation.
- Query answers are computed on every call. Repeated work benefits from an open City and prepared indexes, not saved answers.
- Runtime preparation, temporary-file cleanup, and worker lifetime are managed automatically.
- Build, open, compute, and end-to-end timings remain separate.

VIGO 0.3 intentionally removes the provisional commands, Python package, maintenance controls, and duplicate analysis surfaces that preceded this model. There is no compatibility layer.
