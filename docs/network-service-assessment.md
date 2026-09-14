# Network service assessment

The briefing starts with the distribution of conditions across reporting service. It then identifies shared locations, longer waits relative to the same scheduled departures, and what remains unreported. It is generated from the shared Agency observation and retained with its route and trip evidence.

The computed assessment appears immediately. It leads with the spread of late predictions, then prioritizes shared-area delays separately from longer rider waits. Whole-minute descriptions support the finding; quantiles and route counts remain evidence, not the headline. Ask receives a compact version of the same diagnosis through `network_overview`.

When a provider is configured and late predictions are present, a bounded investigation follows. The model chooses a focus and candidate explanations, then up to two additional evidence checks. Agency notices and upstream predictions are always checked. It assesses the resulting facts as plausible, weakened or unresolved, cites support and counterevidence, and chooses what to observe next. Two schema-constrained model calls have a shared 75-second deadline; no larger model is required. Invalid assessments retain the computed briefing and completed checks.

## Measurements and denominators

- **Service window:** the next 30 minutes, using the existing observation policy. Scheduled trips contribute only the seconds during which their indexed first departure–last arrival span intersects the window. Calendar exceptions and preceding service days with 24:00+ trips are included using the GTFS service clock. Frequency templates are explicitly excluded.
- **Reporting coverage:** scheduled vehicle-minutes belonging to trips with a usable upcoming departure prediction or cancellation report, divided by all scheduled vehicle-minutes in the window. This weights frequent service by its actual scheduled supply. It is neither passenger coverage nor a health percentage.
- **Timetable deviation:** one next departure per reporting trip instance. Median and 90th-percentile absolute deviations use empirical nearest ranks. Early, exactly matching, and late predictions are kept separate. Additional reporting trips outside the scheduled window remain in the timing distribution and are counted separately in coverage.
- **Spacing:** only consecutive scheduled departures with both predictions at the same stop, direction and service date qualify. Equal intervals are retained. The same pair at multiple stops counts as one pair; its largest increase and stop extent are retained. Missing intermediate trips cannot become a measured service gap.
- **History:** repeated late predictions require distinct source timestamps at the same trip and stop. The retained history supplies a measured duration and change, not an incident onset, actual passage history, or recovery forecast.

All indexed routes receive a state. No predictions means unknown; no scheduled trips means no scheduled service in this window. A single late prediction is distinguished from several late predictions. These are descriptive states, not hidden severity thresholds or claims about an agency's on-time standard. Exact matching predictions establish only the checked next departures.

## Spatial interpretation

The geographic unit is an exact directed GTFS connection between stops. Overlapping scheduled-to-predicted departure windows on two or more routes identify a shared-location delay pattern. Adjacent segments connect only when the original segment observations have the same routes, overlapping windows, and a common affected trip. Connected components form the concentrations; an aggregate time envelope cannot create a new connection between otherwise separate observations. Each trip counts once in a concentration. Concentrations are ranked by summed positive departure delay across their distinct reporting trips, not the number of stop records or equal route weights.

This establishes where predicted lateness overlaps. It does not establish that delay originated on that segment, a corridor travel-speed reduction, propagation, a common incident cause, or passenger demand. Reverse-direction segments and non-overlapping time windows remain separate. Stops with similar names or nearby coordinates are not merged. Labels come from the timetable; no Boston neighborhoods are embedded in the method.

The implemented hierarchy is network → shared corridor/location → route → trip. Administrative regions, learned normal-variability ranges, passenger-weighted impact, and forecasts need additional agency data and validation. They are not fabricated to fill a five-layer diagram. Published alerts remain available in the shared observation and route views; the diagnosis does not infer a cause from their titles. The investigation can use an applicable notice as attributed evidence, with its stated route scope. Accessibility-only and no-effect notices are excluded from vehicle-delay explanations, while remaining available in the ordinary alerts views.

## Bounded causal investigation

`briefingInvestigation.mjs` chooses and executes checks through the existing tool registry. `serviceInvestigationEvidence.mjs` uses the same immutable observation as the diagnosis. `briefingInterpretation.mjs` constructs public facts and realizes the model's selected explanation. The model can select hypotheses and evidence IDs; it cannot generate new numerical observations, incident labels, probabilities or unrestricted prose in this briefing path.

The candidate space is deliberately small: a shared corridor disruption, delay carried by individual trips, terminal/dispatch issues, or reporting inconsistency. The model can leave these unresolved. An upstream forecast can challenge a claim that delay began in the selected area, but does not establish an observed onset. Absent notices, missing vehicle positions and unavailable historical studies cannot be cited as support or counterevidence. Model-assessed plausible explanations precede unresolved or weakened ones. These remain working explanations, not calibrated causal classifications.

A retained observation was tested with the configured local `qwen3.5:4b`. Unrestricted prose invented a blockage and confused scheduled intervals with conditions elsewhere; an early constrained version misused escalator notices. Neither behavior was accepted. The revised form separates notice effects, requires upstream evidence, and preserves support and counterevidence. In the retained test, delay already forecast upstream weakened a corridor-origin explanation. This single case does not establish general model reliability.

The card shows the working explanation and next observation. An expandable investigation contains public evidence, not private model reasoning or JSON. Staff still need dispatch records, measured passage/speed data and corroborated incidents to establish a cause. The [LAMP study](lamp-runtime-study.md) supplies a separate historical benchmark; it does not confirm current delay causes.

## Refresh and saved evidence

The default is every 15 minutes while the network overview is open. Staff can choose 30 minutes, hourly, or manual. Preferences persist per City. Manual mode preserves the selected expiry interval; it stops automatic updates rather than declaring an old assessment current forever.

The server reuses a current assessment across tabs and coalesces concurrent generation requests. Manual refresh explicitly requests a new assessment. Server responses carry current preferences so a tab with older settings cannot keep refreshing an hourly or paused briefing every render.

Each card displays the assessment time, scheduled window and next refresh/expiry. Whole-minute headlines omit interval differences that would round to identical values; exact comparisons remain in the diagnosis. Expired cards, previous timetable revisions and loss of previously fresh prediction feeds do not retain a current-looking narrative. Saved originals remain readable and explicitly dated. A one-shot expiry timer and window-focus check handle idle tabs; there is no minute-by-minute model polling. Source conditions may change within a briefing interval: the displayed assessment time is the observation it describes, not a claim of continuous verification.

## Implementation and verification

`realtimeIntelligence.mjs` retains complete measurements server-side. `serviceWindow.mjs` caches timetable spans per read-only context. `serviceConcentrations.mjs`, `networkDiagnosis.mjs`, and `networkNarrative.mjs` separate spatial grouping, aggregation and communication. `briefingSchedule.mjs` owns refresh validation and expiry. `NetworkAssessment.tsx` renders both the live card and saved evidence.

Run `node test/check-network-diagnosis.mjs` or `npm run check:agency`. Fixtures cover complete and incomplete coverage, equal intervals, one vote per trip, cancellations, stale and duplicate records, arrival-only updates, spatial overlap and separation, direction, no mutation of the shared observation, repeated source observations, overnight service, DST, caching, expiry, persistence and zero LLM calls for the computed briefing. UI, type, documentation and production build checks accompany the change.

## Public references

[GTFS Trip Updates](https://gtfs.org/documentation/realtime/feed-entities/trip-updates/) explicitly distinguishes absent realtime information from on-time service and specifies trip-instance and stop-update semantics. The implementation preserves that distinction.

[TransitMatters Data Dashboard 3.0](https://transitmatters.org/blog/datadashboard3) illustrates the value of service-level measurements and bus performance analysis. VIGO's current prediction-window assessment is not equivalent to its historical performance dataset; no parity or superiority claim is made.
