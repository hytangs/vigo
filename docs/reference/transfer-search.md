# Transfer semantics and search selection

VIGO retains the compact connection scan for queries whose results do not depend
on exceptional transfer rules. Scoped transfer selectors and headway service
remain authoritative; the engine does not silently discard them to gain speed.

## Shared policy

Preparation determines permitted physical transfer edges, station membership,
wheelchair access and ordinary minimum times. Loading scoped rules cannot
reintroduce an inter-stop edge removed by `allowStreetTransfers=false` or the
wheelchair profile. Ordinary unscoped rules cannot invent zero-cost paths.
Both search strategies use the same permission and ready-time primitives.
Scoped selector precedence is resolved by `TransferRule::select_most_specific`.

## Conservative certificate

For each active timetable the engine indexes actual alighting events at which a
rule could differ from the ordinary prepared graph. Incoming trip and route
selectors use the physical trip, including inside linked runs. For reverse
queries it indexes corresponding outgoing boarding events. Equivalent ordinary
rules need no exception event. Possible equal-specificity conflicts remain
exceptions. Headway service always selects stateful search.

Consider a journey whose result differs between the two searches. Immediately
before its **first** exceptional transfer, its prefix consists only of ordinary
rides and transfers. An ordinary earliest-arrival search is therefore a lower
bound on arrival at that transfer's source. If no indexed source event is
reachable within the relevant interval, no such first difference exists. This
covers a faster special connection that is absent from the ordinary winner,
as well as a prohibition that invalidates the winner.

For an earliest-arrival scalar query the interval ends at the ordinary candidate
arrival (or the full horizon when no candidate exists). Every nonnegative-cost
journey improving or tying that candidate must encounter its first exceptional
transfer inside that interval. The certificate examines all post-ride stop
states, not the chosen journey. For alternatives it covers the entire admitted
arrival-slack interval; for Matrix and Reach it covers the entire horizon.
The union of a Matrix's endpoint candidates is an optimistic reachability bound
for every cell.

The reverse argument uses the **last** exceptional transfer: its suffix is
ordinary. If no outgoing exceptional boarding can reach the destination by the
deadline, the reverse scan is equivalent. A scalar reverse candidate limits the
interval to departures no earlier than its own; an invalid candidate still has
its differing transfer inside that interval. Bulk reverse queries retain the
full interval.

These arguments require nonnegative walking and transfer costs, valid monotonic
trip clocks, identical prepared access/egress permissions, and unchanged active
service. Kernel validation enforces the numeric input conditions. A cached
certificate belongs to one resident timetable and includes endpoint candidates,
access times, departure, pre-ride policy and transfer buffer. A narrower horizon,
boarding cap or trip exclusion cannot introduce a new feasible prefix. Failure
to certify selects the stateful search. Errors restore the service index before
returning.

## Validation and observability

`cargo test -p vigo-route --lib` includes independent two-leg enumeration,
headway boundary checks, selector specificity, and seeded competing-path
networks. The latter compare admitted scalar queries and complete forward and
reverse bulk objectives with full stateful search, including changing transfer
buffers and boarding caps. This is executable differential evidence, not a
formal proof of every implementation detail.

With `diagnostics: "profile"` or `"trace"`, `profile.routingDispatch` reports
cumulative ordinary and stateful result-search counts for the resident timetable.
Certificate scans are excluded. Counts reset when a timetable is replaced;
benchmarks must separate first activation, count deltas and warm query latency.
An ordinary-only timetable reports `semantics: "ordinary"`.

Both strategies bound transit scanning by the query horizon; final egress may
finish later. Scheduled ride clocks come from the timetable, independently of
the selected strategy. Only headway rides derive their shifted departure from
the estimated ride duration. Differential checks compare these leg clocks as
well as arrival, boarding and walking objectives; tied objectives can have
different valid vehicle witnesses.

Scheduled segment departure counts remain available in scoped-rule Cities.
Segment counts are not guarantees that every departure can replace a ride in
an existing journey: replacement permissions also depend on adjacent trips.

City warmup uses `native` operation `timetable.prepare`: it activates the same
date, coverage and transfer settings without calculating a throwaway journey.
It returns preparation timing and does not change prepared City files.
