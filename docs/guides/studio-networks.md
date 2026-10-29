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

An ordinary City rebuild does not create a wheelchair profile. In Route's
Journey settings, choose **Prepare wheelchair routing** to build one from the
selected timetable's original GTFS ZIP and the City's original OSM PBF. Studio
shows progress in Tasks and enables wheelchair routing after preparation. The
ordinary City remains usable. Source fingerprints are checked before publication;
changing either input requires preparing the profile again. If the original
files have moved or were temporary uploads, reimport them from local files first.
Unknown vehicle and boarding accessibility is excluded, so a prepared profile
may still report no accessible journey. Inferred streets can have unknown
wheelchair or surface tags. It must never substitute an ordinary walking route.

When supplied, the optional `wheelchair_length` extension provides a wheelchair
path distance; VIGO estimates its travel time at 4.8 km/h. A published wheelchair
time takes precedence. Neither field overrides stairs, excessive slopes or narrow
passages. Elevators still need a time. Fare gates between accessible nodes use
their published time, or an explicit five-second estimate when no time is given.
Gates with unknown endpoint accessibility remain excluded. A zero wheelchair
length on a walkway can use its positive published walking length only when
both endpoints are accessible and declare the same level. This is an estimated
walking cost, never a zero-time shortcut. An accessible entrance flag does not
override stairs on the path to a platform; another entrance may be required.
For example, [MBTA documents these optional fields](https://github.com/mbta/gtfs-documentation/blob/master/reference/gtfs.md#pathwaystxt);
they are not required for feeds using standard pathway dimensions and times.

## Timetable quality during preparation

Preparation repairs small backward arrival or departure times with a cumulative
maximum: an event can be delayed to the preceding event, never moved earlier.
The maximum adjustment to any original event is ten minutes. Stops, trip identity,
and boarding/alighting permissions are retained. The original GTFS archive is
unchanged. Equal consecutive times are possible; these are approximate repaired
schedules, not inferred realistic vehicle speeds.

Trips requiring a larger correction are excluded in full, including any valid
prefix. Both repairs (`repaired_trip_times`) and exclusions (`backward_trip_times`)
produce progress warnings, counts and up to 32 example trip IDs. Repairs are marked
`approximate` in routing limitations. Published after-midnight times such as
`24:10:00` remain valid; a clock reset to `00:10:00` is not interpreted as next day.
Broken references and duplicate stop sequences still fail preparation. The
low-level compiler retains strict rejection by default; preparation explicitly
selects the bounded repair policy.

## Walking access in prepared streets

New pedestrian indexes use the same balanced inertial CCH ordering strategy as
driving. The ordering controls preprocessing cost and shortcut count; it does not
remove streets, change weights or approximate shortest paths. Existing indexes
remain usable without rebuilding. Full inertial and degree ordering remain
available to native callers for controlled comparisons.

Walking preparation follows OSM mode-specific access precedence. An explicit
pedestrian permission overrides general access restrictions, including general
conditional restrictions. A conditional pedestrian rule that only permits walking
is redundant when the explicit base pedestrian rule already permits walking, so
it does not disconnect that way or node. Restrictive or unknown pedestrian
conditions, opening hours, and conditional pedestrian directions remain excluded
from the static graph; VIGO does not yet evaluate them at journey time.

These corrections apply to newly prepared streets. Rebuild a City to incorporate
them; existing prepared Cities remain readable and keep their original graph.
A route reported as not found is constrained by the supplied walking budget,
service date, time horizon, transfer limit, and prepared map coverage. It is not
proof that no journey exists with different settings or additional map data.

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

With **Arrive by**, Route options offers **Exact time** or **Earlier arrivals**.
Earlier arrivals searches each deadline in the 20 minutes before the requested
arrival and lists up to five distinct journeys, each the latest departure for
some deadline, plus a walk when one is possible. The latest departure leads.
A deadline close to midnight is searched on the preceding service day, and
Studio shows those times on the day you asked for, so a daylight-saving change
does not shift them; journeys that would leave before that day are not listed.
Choosing Arrive by opens that preceding day's timetable while you pick points.
