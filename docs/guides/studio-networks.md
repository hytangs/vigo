# Networks within one City

A Studio City can contain multiple GTFS timetables. The Route network selector
can query one imported timetable independently or run a saved scenario on its
assigned timetable group. Selecting a single feed uses its own prepared store;
it does not require a merged City index or mix in other feeds.

A City may set `defaultRoutingFeedId` in its Studio project metadata to choose
its default network. This is optional Studio metadata, not a change to the
portable prepared City format. Without it, the existing City timetable remains
the default. Network options are derived from imported feeds and saved scenarios;
there is no fixed list of networks.

A prepared wheelchair network must match the selected GTFS source and the City's
street source. A matching baseline can be used even when the City also contains
alternative feeds. Selecting a different network does not reuse that wheelchair
profile. Query-time scenario changes still require their own accessibility
preparation; ordinary routes are never substituted for wheelchair requests.

## Timetable quality during preparation

Preparation continues when individual trips contain backward arrival or departure
times. It excludes each malformed trip in full and records a `backward_trip_times`
limitation, a count, and up to 32 example trip identifiers. It also emits a progress
warning. Valid trips remain available, and the original GTFS archive is unchanged.

VIGO does not guess realistic travel times or silently turn a backward clock into
a next-day service. Published GTFS times such as `24:10:00` remain valid. Other
structural failures, including broken stop references and duplicate stop sequences,
still fail preparation. The low-level connection compiler retains strict rejection
by default; preparation explicitly selects its quarantine policy.

## Road-following scenario paths

Road tracing depends on the City's street network and the ordered stops. Draft
status updates and save acknowledgements must not cancel the trace. Changing the
City or actual timetable-group selection still invalidates it. A disconnected
road segment produces an explanation; a straight line is not labeled a road path.

## Journey choices

Studio's later-departure search supplements its timetable window with the Rust
ranked search at the requested clock: up to 64 candidate vehicle chains within
fifteen minutes of the earliest arrival. Rust selects at most ten results,
prioritizing distinct line and boarding/alighting combinations before repeated
departures. A result is removed when another journey leaves no earlier, arrives
no later, walks no more and boards no more vehicles, and is better on at least
one of these in the whole minutes Studio shows. The leave time is the one Studio
displays: an initial walk is deferred to reach the first vehicle just in time.
A later departure that arrives later is kept as a real choice. Journeys on the
same lines that read the same at those minutes are one choice. Dominated
station-return detours and unnecessary changes onto the same vehicle are
removed only when a feasible simpler witness exists. Existing walking, transfer, accessibility,
service-date and selected-network constraints still apply. This is a bounded
candidate search, not a claim to enumerate every possible itinerary.

The list groups services only when their ordered stops, verified ride geometry
and access paths match. Each departure keeps its original itinerary and times.
Different corridors remain separate. Redundant changes onto a vehicle already
offered directly are hidden when they offer no arrival or walking benefit.
