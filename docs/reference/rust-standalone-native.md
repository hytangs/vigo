# Native Rust field reference

Generated for VIGO 0.4.3 from public Rust structs. Regenerate with `npm run docs:standalone`.

Use the [standalone manual](../guides/rust-standalone.md#18-native-operation-reference) for units, index domains, and examples. In requests, an optional field accepts omission or null. Result objects include every listed field; an unavailable optional value is null. Native arrays become JSON arrays, and non-finite result numbers become null. The runtime also checks compatible array lengths, indices, and values.

| Operation | Input | Result |
| --- | --- | --- |
| `timetable.identifiers` | No input object | Active identifier arrays |
| `timetable.route` | [TimetableQueryInput](#timetablequeryinput) | [TimetableQueryResult](#timetablequeryresult) |
| `timetable.arrive_by` | [TimetableArriveByQueryInput](#timetablearrivebyqueryinput) | [TimetableArriveByQueryResult](#timetablearrivebyqueryresult) |
| `timetable.matrix` | [TimetableMatrixQueryInput](#timetablematrixqueryinput) | [TimetableMatrixQueryResult](#timetablematrixqueryresult) |
| `timetable.many` | [TimetableManyQueryInput](#timetablemanyqueryinput) | [TimetableManyQueryResult](#timetablemanyqueryresult) |
| `timetable.arrive_by_many` | [TimetableArriveByManyQueryInput](#timetablearrivebymanyqueryinput) | [TimetableArriveByManyQueryResult](#timetablearrivebymanyqueryresult) |
| `timetable.pareto` | [TimetableParetoQueryInput](#timetableparetoqueryinput) | [TimetableParetoQueryResult](#timetableparetoqueryresult) |
| `timetable.overlay` | [TimetableOverlayManyQueryInput](#timetableoverlaymanyqueryinput) | [TimetableOverlayManyQueryResult](#timetableoverlaymanyqueryresult) |
| `access.endpoint` | [EndpointRoleInput](#endpointroleinput) | [EndpointRoleResult](#endpointroleresult) |
| `access.endpoints` | [EndpointRouteInput](#endpointrouteinput) | [EndpointRouteResult](#endpointrouteresult) |
| `street.path` | [StreetPathInput](#streetpathinput) | [StreetPathResult](#streetpathresult) |
| `street.matrix` | [StreetMatrixInput](#streetmatrixinput) | [StreetMatrixResult](#streetmatrixresult) |
| `street.surface` | [StreetSurfaceInput](#streetsurfaceinput) | [StreetSurfaceResult](#streetsurfaceresult) |
| `street.connectors` | [TimedConnectorInput](#timedconnectorinput) | [TimedConnectorResult](#timedconnectorresult) |
| `drive.route` | [DriveQueryInput](#drivequeryinput) | [DriveQueryResult](#drivequeryresult) |
| `drive.matrix` | [DriveMatrixInput](#drivematrixinput) | [DriveMatrixResult](#drivematrixresult) |
| `realtime.compile` | [RealtimeTimetableInput](#realtimetimetableinput) | [RealtimeTimetableResult](#realtimetimetableresult) |

## DriveMatrixInput

Source: `native/vigo-routing-kernel/src/exact_routing.rs`.

| JSON field | Rust / JSON type | Required | Meaning |
| --- | --- | --- | --- |
| `originOffsets` | `Vec<u32>` | Yes | Cumulative boundaries grouping packed origin candidates; starts at zero. |
| `originNodes` | `Vec<u32>` | Yes | Drive-graph candidate node indices for origins. |
| `originSnapMeters` | `Vec<f64>` | Yes | Origin snap distances in meters, parallel to candidate nodes. |
| `targetOffsets` | `Vec<u32>` | Yes | Cumulative boundaries grouping packed drive target candidates. |
| `targetNodes` | `Vec<u32>` | Yes | Drive-graph candidate node indices for destinations. |
| `targetSnapMeters` | `Vec<f64>` | Yes | Destination snap distances in meters, parallel to candidate nodes. |
| `maximumDistanceMeters` | `f64` | Yes | Maximum drive path distance in meters. |
| `traffic` | `Option<DriveTrafficInput>` | No | Optional directed drive-edge metric updates. |

## DriveMatrixResult

Source: `native/vigo-routing-kernel/src/exact_routing.rs`.

| JSON field | Rust / JSON type | Present | Meaning |
| --- | --- | --- | --- |
| `distancesM` | `Vec<f64>` | Always | Flat origin-major matrix of distances in meters; null marks an unreachable pair. |
| `durationsS` | `Vec<f64>` | Always | Flat origin-major matrix of travel durations in seconds; null marks an unreachable pair. |
| `readyPairs` | `u32` | Always | — |
| `cchCandidateQueries` | `u32` | Always | — |
| `pathQueries` | `u32` | Always | — |
| `queryNs` | `f64` | Always | Native query time in nanoseconds; excludes outer transport work. |
| `cchAccelerated` | `bool` | Always | — |
| `trafficApplied` | `bool` | Always | — |
| `trafficSnapshotKey` | `Option<String>` | Always | — |
| `trafficUpdatedEdges` | `u32` | Always | — |
| `trafficCustomizationNs` | `f64` | Always | — |
| `trafficMetricReused` | `bool` | Always | — |
| `algorithm` | `String` | Always | — |

## DriveQueryInput

Source: `native/vigo-routing-kernel/src/exact_routing.rs`.

| JSON field | Rust / JSON type | Required | Meaning |
| --- | --- | --- | --- |
| `originNodes` | `Vec<u32>` | Yes | Drive-graph candidate node indices for origins. |
| `originSnapMeters` | `Vec<f64>` | Yes | Origin snap distances in meters, parallel to candidate nodes. |
| `targetNodes` | `Vec<u32>` | Yes | Drive-graph candidate node indices for destinations. |
| `targetSnapMeters` | `Vec<f64>` | Yes | Destination snap distances in meters, parallel to candidate nodes. |
| `maximumDistanceMeters` | `f64` | Yes | Maximum drive path distance in meters. |
| `traffic` | `Option<DriveTrafficInput>` | No | Optional directed drive-edge metric updates. |

## DriveQueryResult

Source: `native/vigo-routing-kernel/src/exact_routing.rs`.

| JSON field | Rust / JSON type | Present | Meaning |
| --- | --- | --- | --- |
| `supported` | `bool` | Always | — |
| `status` | `String` | Always | — |
| `reason` | `Option<String>` | Always | — |
| `distanceMeters` | `Option<f64>` | Always | Selected drive-path distance in meters. |
| `durationSeconds` | `Option<f64>` | Always | Selected drive-path duration in seconds. |
| `originSnapMeters` | `Option<f64>` | Always | Distance in meters from the selected origin point to the drive graph. |
| `targetSnapMeters` | `Option<f64>` | Always | Distance in meters from the drive graph to the selected destination point. |
| `nodeIndices` | `Vec<u32>` | Always | Ordered node indices in the active drive graph for the selected path. |
| `settledLabels` | `u32` | Always | — |
| `relaxedEdges` | `u32` | Always | — |
| `generatedLabels` | `u32` | Always | — |
| `dominatedLabels` | `u32` | Always | — |
| `fastPathQueryNs` | `f64` | Always | — |
| `distancePathQueryNs` | `f64` | Always | — |
| `fallbackQueryNs` | `f64` | Always | — |
| `fallbackUsed` | `bool` | Always | — |
| `cchAccelerated` | `bool` | Always | — |
| `cchCandidateQueries` | `u32` | Always | — |
| `cchSource` | `String` | Always | — |
| `trafficApplied` | `bool` | Always | — |
| `trafficSnapshotKey` | `Option<String>` | Always | — |
| `trafficUpdatedEdges` | `u32` | Always | — |
| `trafficCustomizationNs` | `f64` | Always | — |
| `trafficMetricReused` | `bool` | Always | — |
| `queryNs` | `f64` | Always | Native query time in nanoseconds; excludes outer transport work. |
| `algorithm` | `String` | Always | — |

## DriveTrafficInput

Source: `native/vigo-routing-kernel/src/exact_routing.rs`.

| JSON field | Rust / JSON type | Required | Meaning |
| --- | --- | --- | --- |
| `snapshotKey` | `String` | Yes | Caller metric identity; the standalone adapter binds caches to actual weights. |
| `edgeIndices` | `Vec<u32>` | Yes | Directed edge indices in the active drive graph. |
| `edgeTimeUnits` | `Vec<u32>` | Yes | Weights in hundredths of seconds; 2147483647 closes an edge. |

## EndpointRoleInput

Source: `native/vigo-routing-kernel/src/lib.rs`.

| JSON field | Rust / JSON type | Required | Meaning |
| --- | --- | --- | --- |
| `longitude` | `f64` | Yes | WGS84 longitude in degrees. |
| `latitude` | `f64` | Yes | WGS84 latitude in degrees. |
| `maximumWalkM` | `f64` | Yes | Maximum endpoint or terminal walking distance in meters. |
| `walkingSpeedKph` | `Option<f64>` | No | Walking speed in kilometers per hour; omission uses the prepared policy. |
| `accessPaddingFactor` | `Option<f64>` | No | Multiplier applied to transit endpoint walking time. |
| `accessOverheadSeconds` | `Option<f64>` | No | Fixed transit endpoint access overhead in seconds. |
| `role` | `String` | Yes | Endpoint direction: origin or destination; directed walking access and egress differ. |
| `disableCache` | `Option<bool>` | No | Disable endpoint cache reuse for this call. |

## EndpointRoleResult

Source: `native/vigo-routing-kernel/src/lib.rs`.

| JSON field | Rust / JSON type | Present | Meaning |
| --- | --- | --- | --- |
| `queryToken` | `u32` | Always | — |
| `cacheHit` | `bool` | Always | — |
| `memberIndices` | `Vec<u32>` | Always | — |
| `pathMemberIndices` | `Vec<u32>` | Always | — |
| `distancesM` | `Vec<f64>` | Always | — |
| `accessSeconds` | `Vec<u32>` | Always | — |
| `candidateKinds` | `Vec<u32>` | Always | — |
| `linkFromStopKeys` | `Vec<u32>` | Always | — |
| `linkToStopKeys` | `Vec<u32>` | Always | — |
| `linkDurations` | `Vec<u32>` | Always | — |
| `linkPathDistancesM` | `Vec<f64>` | Always | — |
| `linkStreetVerified` | `Vec<u32>` | Always | — |
| `queryNs` | `f64` | Always | Native query time in nanoseconds; excludes outer transport work. |
| `accessReductionNs` | `f64` | Always | — |
| `snapNs` | `f64` | Always | — |
| `searchNs` | `f64` | Always | — |
| `settledNodes` | `u32` | Always | — |
| `relaxedEdges` | `u32` | Always | — |
| `rawCandidates` | `u32` | Always | — |
| `linkedStations` | `u32` | Always | — |
| `cchAccelerated` | `bool` | Always | — |

## EndpointRouteInput

Source: `native/vigo-routing-kernel/src/lib.rs`.

| JSON field | Rust / JSON type | Required | Meaning |
| --- | --- | --- | --- |
| `originLon` | `f64` | Yes | Origin longitude in degrees. |
| `originLat` | `f64` | Yes | Origin latitude in degrees. |
| `destinationLon` | `f64` | Yes | Destination longitude in degrees. |
| `destinationLat` | `f64` | Yes | Destination latitude in degrees. |
| `maximumWalkM` | `f64` | Yes | Maximum endpoint or terminal walking distance in meters. |
| `walkingSpeedKph` | `Option<f64>` | No | Walking speed in kilometers per hour; omission uses the prepared policy. |
| `accessPaddingFactor` | `Option<f64>` | No | Multiplier applied to transit endpoint walking time. |
| `accessOverheadSeconds` | `Option<f64>` | No | Fixed transit endpoint access overhead in seconds. |
| `disableCache` | `Option<bool>` | No | Disable endpoint cache reuse for this call. |

## EndpointRouteResult

Source: `native/vigo-routing-kernel/src/lib.rs`.

| JSON field | Rust / JSON type | Present | Meaning |
| --- | --- | --- | --- |
| `queryToken` | `u32` | Always | — |
| `cacheHit` | `bool` | Always | — |
| `originCacheHit` | `bool` | Always | — |
| `destinationCacheHit` | `bool` | Always | — |
| `originMemberIndices` | `Vec<u32>` | Always | — |
| `originPathMemberIndices` | `Vec<u32>` | Always | — |
| `originDistancesM` | `Vec<f64>` | Always | — |
| `originAccessSeconds` | `Vec<u32>` | Always | — |
| `originCandidateKinds` | `Vec<u32>` | Always | — |
| `originLinkFromStopKeys` | `Vec<u32>` | Always | — |
| `originLinkToStopKeys` | `Vec<u32>` | Always | — |
| `originLinkDurations` | `Vec<u32>` | Always | — |
| `originLinkPathDistancesM` | `Vec<f64>` | Always | — |
| `originLinkStreetVerified` | `Vec<u32>` | Always | — |
| `originAccessReductionNs` | `f64` | Always | — |
| `destinationMemberIndices` | `Vec<u32>` | Always | — |
| `destinationPathMemberIndices` | `Vec<u32>` | Always | — |
| `destinationDistancesM` | `Vec<f64>` | Always | — |
| `destinationAccessSeconds` | `Vec<u32>` | Always | — |
| `destinationCandidateKinds` | `Vec<u32>` | Always | — |
| `destinationLinkFromStopKeys` | `Vec<u32>` | Always | — |
| `destinationLinkToStopKeys` | `Vec<u32>` | Always | — |
| `destinationLinkDurations` | `Vec<u32>` | Always | — |
| `destinationLinkPathDistancesM` | `Vec<f64>` | Always | — |
| `destinationLinkStreetVerified` | `Vec<u32>` | Always | — |
| `destinationAccessReductionNs` | `f64` | Always | — |
| `queryNs` | `f64` | Always | Native query time in nanoseconds; excludes outer transport work. |
| `accessReductionNs` | `f64` | Always | — |
| `snapNs` | `f64` | Always | — |
| `originSearchNs` | `f64` | Always | — |
| `destinationSearchNs` | `f64` | Always | — |
| `originSettledNodes` | `u32` | Always | — |
| `destinationSettledNodes` | `u32` | Always | — |
| `originRelaxedEdges` | `u32` | Always | — |
| `destinationRelaxedEdges` | `u32` | Always | — |
| `originRawCandidates` | `u32` | Always | — |
| `destinationRawCandidates` | `u32` | Always | — |
| `originLinkedStations` | `u32` | Always | — |
| `destinationLinkedStations` | `u32` | Always | — |
| `originCchAccelerated` | `bool` | Always | — |
| `destinationCchAccelerated` | `bool` | Always | — |

## RealtimeCallInput

Source: `native/vigo-routing-kernel/src/timetable/realtime.rs`.

| JSON field | Rust / JSON type | Required | Meaning |
| --- | --- | --- | --- |
| `stop` | `u32` | Yes | — |
| `arrival` | `f64` | Yes | — |
| `departure` | `f64` | Yes | Earliest departure clock in service-day seconds. |
| `sequence` | `f64` | Yes | — |
| `canBoard` | `bool` | Yes | — |
| `canAlight` | `bool` | Yes | — |

## RealtimeTimetableInput

Source: `native/vigo-routing-kernel/src/timetable/realtime.rs`.

| JSON field | Rust / JSON type | Required | Meaning |
| --- | --- | --- | --- |
| `stopCount` | `u32` | Yes | — |
| `departureSeconds` | `Uint32Array` | Yes | — |
| `arrivalSeconds` | `Uint32Array` | Yes | — |
| `fromStop` | `Uint32Array` | Yes | — |
| `toStop` | `Uint32Array` | Yes | — |
| `sequence` | `Uint32Array` | Yes | — |
| `segmentRun` | `Uint32Array` | Yes | — |
| `continuityBreak` | `Uint8Array` | Yes | — |
| `canBoard` | `Uint8Array` | Yes | — |
| `canAlight` | `Uint8Array` | Yes | — |
| `tripStart` | `Uint32Array` | Yes | — |
| `canceled` | `Uint8Array` | Yes | Per-trip cancellation flags in the supplied baseline timetable. |
| `replacements` | `Vec<RealtimeTripInput>` | Yes | Explicit effective calls replacing identified baseline trips. |

## RealtimeTimetableResult

Source: `native/vigo-routing-kernel/src/timetable/realtime.rs`.

| JSON field | Rust / JSON type | Present | Meaning |
| --- | --- | --- | --- |
| `departureSeconds` | `Uint32Array` | Always | — |
| `arrivalSeconds` | `Uint32Array` | Always | — |
| `fromStop` | `Uint32Array` | Always | — |
| `toStop` | `Uint32Array` | Always | — |
| `sequence` | `Uint32Array` | Always | — |
| `segmentTrip` | `Uint32Array` | Always | — |
| `segmentRun` | `Uint32Array` | Always | — |
| `continuityBreak` | `Uint8Array` | Always | — |
| `canBoard` | `Uint8Array` | Always | — |
| `canAlight` | `Uint8Array` | Always | — |
| `tripStart` | `Uint32Array` | Always | — |
| `departureOffset` | `Uint32Array` | Always | — |
| `departureOrder` | `Uint32Array` | Always | — |
| `runCount` | `u32` | Always | — |
| `activeSegmentCount` | `u32` | Always | — |
| `realtimeTripIndices` | `Uint32Array` | Always | — |

## RealtimeTripInput

Source: `native/vigo-routing-kernel/src/timetable/realtime.rs`.

| JSON field | Rust / JSON type | Required | Meaning |
| --- | --- | --- | --- |
| `trip` | `u32` | Yes | — |
| `stops` | `Vec<RealtimeCallInput>` | Yes | — |

## StreetMatrixInput

Source: `native/vigo-routing-kernel/src/lib.rs`.

| JSON field | Rust / JSON type | Required | Meaning |
| --- | --- | --- | --- |
| `originCoordinates` | `Vec<f64>` | Yes | Flat longitude/latitude pairs in origin row order. |
| `destinationCoordinates` | `Vec<f64>` | Yes | Flat longitude/latitude pairs in destination column order. |
| `maximumDistanceM` | `f64` | Yes | Maximum street path distance in meters. |
| `disableCache` | `Option<bool>` | No | Disable endpoint cache reuse for this call. |

## StreetMatrixResult

Source: `native/vigo-routing-kernel/src/lib.rs`.

| JSON field | Rust / JSON type | Present | Meaning |
| --- | --- | --- | --- |
| `reusedEndpointSnaps` | `u32` | Always | — |
| `distancesM` | `Vec<f64>` | Always | Flat origin-major matrix of directed street distances in meters; null marks an unreachable pair. |
| `readyPairs` | `u32` | Always | — |
| `sourceCandidates` | `u32` | Always | — |
| `destinationCandidates` | `u32` | Always | — |
| `queryNs` | `f64` | Always | Native query time in nanoseconds; excludes outer transport work. |
| `cchAccelerated` | `bool` | Always | — |
| `algorithm` | `String` | Always | — |

## StreetPathInput

Source: `native/vigo-routing-kernel/src/lib.rs`.

| JSON field | Rust / JSON type | Required | Meaning |
| --- | --- | --- | --- |
| `originLon` | `f64` | Yes | Origin longitude in degrees. |
| `originLat` | `f64` | Yes | Origin latitude in degrees. |
| `destinationLon` | `f64` | Yes | Destination longitude in degrees. |
| `destinationLat` | `f64` | Yes | Destination latitude in degrees. |
| `maximumDistanceM` | `f64` | Yes | Maximum street path distance in meters. |
| `maximumPoints` | `u32` | Yes | Maximum number of returned path geometry points. |

## StreetPathResult

Source: `native/vigo-routing-kernel/src/lib.rs`.

| JSON field | Rust / JSON type | Present | Meaning |
| --- | --- | --- | --- |
| `found` | `bool` | Always | — |
| `distanceM` | `f64` | Always | Returned path distance in meters. |
| `originSnapDistanceM` | `f64` | Always | — |
| `destinationSnapDistanceM` | `f64` | Always | — |
| `coordinates` | `Vec<f64>` | Always | Flat longitude/latitude pairs describing the returned path. |
| `queryNs` | `f64` | Always | Native query time in nanoseconds; excludes outer transport work. |
| `settledNodes` | `u32` | Always | — |
| `relaxedEdges` | `u32` | Always | — |
| `chainSkippedNodes` | `u32` | Always | — |
| `contractedArcRelaxations` | `u32` | Always | — |
| `cchAccelerated` | `bool` | Always | — |

## StreetSurfaceEdge

Source: `native/vigo-routing-kernel/src/street_analysis.rs`.

| JSON field | Rust / JSON type | Present | Meaning |
| --- | --- | --- | --- |
| `fromLongitude` | `f64` | Always | — |
| `fromLatitude` | `f64` | Always | — |
| `toLongitude` | `f64` | Always | — |
| `toLatitude` | `f64` | Always | — |
| `durationMinutes` | `f64` | Always | — |
| `walkDistanceM` | `f64` | Always | — |
| `transitArrivalMinutes` | `Option<f64>` | Always | — |

## StreetSurfaceInput

Source: `native/vigo-routing-kernel/src/street_analysis.rs`.

| JSON field | Rust / JSON type | Required | Meaning |
| --- | --- | --- | --- |
| `bounds` | `Vec<f64>` | Yes | Geographic bounds in west, south, east, north order. |
| `width` | `u32` | Yes | Number of raster columns. |
| `height` | `u32` | Yes | Number of raster rows. |
| `seedCoordinates` | `Vec<f64>` | Yes | Flat longitude/latitude pairs for surface/connector seeds. |
| `seedDurationsMinutes` | `Vec<f64>` | Yes | Elapsed minutes already spent reaching each seed. |
| `maximumWalkM` | `f64` | Yes | Maximum endpoint or terminal walking distance in meters. |
| `walkSpeedKph` | `f64` | Yes | Walking speed in kilometers per hour. |
| `maximumDurationMinutes` | `f64` | Yes | Maximum elapsed duration accepted by the surface/connector query. |
| `independentTerminalWalk` | `bool` | Yes | — |
| `includeNodes` | `bool` | Yes | Return native reached-node evidence. |
| `nodeEvidenceLimit` | `u32` | Yes | Node evidence cap, clamped to 1..100000; zero therefore returns at most one node. |
| `includeEdges` | `bool` | Yes | Return native directed-edge evidence. |
| `edgeEvidenceLimit` | `u32` | Yes | Edge evidence cap; zero means no caller truncation limit. |
| `expandBoundsToReachedEdges` | `bool` | Yes | Also construct a raster with bounds derived from reached street evidence; these bounds need not contain the requested bounds. |

## StreetSurfaceNode

Source: `native/vigo-routing-kernel/src/street_analysis.rs`.

| JSON field | Rust / JSON type | Present | Meaning |
| --- | --- | --- | --- |
| `longitude` | `f64` | Always | WGS84 longitude in degrees. |
| `latitude` | `f64` | Always | WGS84 latitude in degrees. |
| `durationMinutes` | `f64` | Always | — |
| `walkDistanceM` | `f64` | Always | — |

## StreetSurfaceResult

Source: `native/vigo-routing-kernel/src/street_analysis.rs`.

| JSON field | Rust / JSON type | Present | Meaning |
| --- | --- | --- | --- |
| `values` | `Vec<f64>` | Always | Elapsed minutes on the requested raster, flattened by row from the northwest corner. Null marks an unreached cell. |
| `fullSurfaceValues` | `Option<Vec<f64>>` | Always | Elapsed minutes on the recomputed raster, using fullSurfaceBounds and the requested dimensions. Null when no separate raster is returned. |
| `fullSurfaceBounds` | `Option<Vec<f64>>` | Always | Recomputed raster bounds in west, south, east, north order; can be smaller or larger than requested. Null when no separate raster is returned. |
| `snappedSeeds` | `u32` | Always | — |
| `settledLabels` | `u32` | Always | — |
| `relaxedEdges` | `u32` | Always | — |
| `retainedLabels` | `u32` | Always | — |
| `reachedPixels` | `u32` | Always | — |
| `queryNs` | `f64` | Always | Native query time in nanoseconds; excludes outer transport work. |
| `nodeEvidence` | `Vec<StreetSurfaceNode>` | Always | — |
| `nodeEvidenceTruncated` | `bool` | Always | True when reached-node samples exceeded nodeEvidenceLimit after clamping. |
| `reachedEdgeCount` | `u32` | Always | — |
| `reachedEdgeLengthM` | `f64` | Always | — |
| `edgeEvidence` | `Vec<StreetSurfaceEdge>` | Always | — |
| `edgeEvidenceTruncated` | `bool` | Always | — |
| `edgeEvidenceNodes` | `Option<Float64Array>` | Always | — |
| `edgeEvidenceEndpoints` | `Option<Uint32Array>` | Always | — |
| `edgeEvidenceIds` | `Option<Uint32Array>` | Always | — |
| `edgeEvidenceDurations` | `Option<Float64Array>` | Always | Elapsed minutes to each retained directed edge to-endpoint, not the duration of that edge alone. |
| `edgeEvidenceWalkDistances` | `Option<Float64Array>` | Always | — |
| `edgeEvidenceTransitArrivals` | `Option<Float64Array>` | Always | Elapsed seed duration for each indexed edge; -1 marks seed index zero. |

## TimedConnectorInput

Source: `native/vigo-routing-kernel/src/street_analysis.rs`.

| JSON field | Rust / JSON type | Required | Meaning |
| --- | --- | --- | --- |
| `seedCoordinates` | `Vec<f64>` | Yes | Flat longitude/latitude pairs for surface/connector seeds. |
| `seedDurationsMinutes` | `Vec<f64>` | Yes | Elapsed minutes already spent reaching each seed. |
| `seedMaximumWalkM` | `Vec<f64>` | Yes | Per-seed remaining walking allowance in meters. |
| `seedIndices` | `Vec<u32>` | Yes | Caller seed identities, parallel to seed coordinate pairs. |
| `targetCoordinates` | `Vec<f64>` | Yes | Flat longitude/latitude pairs in target order. |
| `defaultMaximumWalkM` | `f64` | Yes | Default walking allowance in meters. |
| `walkSpeedKph` | `f64` | Yes | Walking speed in kilometers per hour. |
| `maximumDurationMinutes` | `f64` | Yes | Maximum elapsed duration accepted by the surface/connector query. |
| `includeTargetMatrix` | `bool` | Yes | Include the seed-to-target connector matrix. |

## TimedConnectorResult

Source: `native/vigo-routing-kernel/src/street_analysis.rs`.

| JSON field | Rust / JSON type | Present | Meaning |
| --- | --- | --- | --- |
| `durationsMinutes` | `Vec<f64>` | Always | — |
| `walkDistancesM` | `Vec<f64>` | Always | — |
| `seedIndices` | `Vec<i32>` | Always | Caller seed identities, parallel to seed coordinate pairs. |
| `matrixDurationsMinutes` | `Vec<f64>` | Always | — |
| `matrixWalkDistancesM` | `Vec<f64>` | Always | — |
| `matrixReadyPairs` | `u32` | Always | — |
| `searches` | `u32` | Always | — |
| `snappedSeeds` | `u32` | Always | — |
| `snappedTargets` | `u32` | Always | — |
| `reachedTargets` | `u32` | Always | — |
| `settledLabels` | `u32` | Always | — |
| `relaxedEdges` | `u32` | Always | — |
| `retainedLabels` | `u32` | Always | — |
| `aggregateCchAccelerated` | `bool` | Always | — |
| `aggregateCchQueryNs` | `f64` | Always | — |
| `matrixCchAccelerated` | `bool` | Always | — |
| `matrixCchQueryNs` | `f64` | Always | — |
| `queryNs` | `f64` | Always | Native query time in nanoseconds; excludes outer transport work. |

## TimetableArriveByManyQueryInput

Source: `native/vigo-routing-kernel/src/timetable.rs`.

| JSON field | Rust / JSON type | Required | Meaning |
| --- | --- | --- | --- |
| `originOffsets` | `Vec<u32>` | Yes | Cumulative boundaries grouping packed origin candidates; starts at zero. |
| `originStops` | `Vec<u32>` | Yes | Resident timetable stop indices for origin candidates. |
| `originWalkSeconds` | `Vec<f64>` | Yes | Access seconds parallel to origin stop candidates. |
| `allowPreRideTransfers` | `Vec<bool>` | Yes | Allow transfer-graph movement before first boarding; per-origin arrays for grouped queries. |
| `destinationStops` | `Vec<u32>` | Yes | Resident timetable stop indices for destination candidates. |
| `destinationWalkSeconds` | `Vec<f64>` | Yes | Egress seconds parallel to destination stop candidates. |
| `earliest` | `f64` | Yes | Earliest permitted search clock in service-day seconds. |
| `deadline` | `f64` | Yes | Arrival deadline in service-day seconds. |
| `excludedTrips` | `Vec<u32>` | Yes | Active trip indices to exclude from this query. |
| `allowPostRideTransfers` | `Option<bool>` | No | Allow transfer-graph movement after the last ride; per-destination arrays where typed. |
| `maximumBoardings` | `Option<u32>` | No | Vehicle boarding cap, one larger than a transfer cap. |

## TimetableArriveByManyQueryResult

Source: `native/vigo-routing-kernel/src/timetable.rs`.

| JSON field | Rust / JSON type | Present | Meaning |
| --- | --- | --- | --- |
| `latestDepartures` | `Vec<f64>` | Always | Latest departure clocks in service-day seconds, in origin-group order. Null marks an unreachable origin. |
| `queryNs` | `f64` | Always | Native query time in nanoseconds; excludes outer transport work. |
| `scannedDepartures` | `u32` | Always | — |
| `excludedDepartures` | `u32` | Always | — |
| `relaxedStops` | `u32` | Always | — |
| `expandedTripRuns` | `u32` | Always | — |
| `dominatedTripBoardings` | `u32` | Always | — |
| `explicitTransferChecks` | `u32` | Always | — |

## TimetableArriveByQueryInput

Source: `native/vigo-routing-kernel/src/timetable.rs`.

| JSON field | Rust / JSON type | Required | Meaning |
| --- | --- | --- | --- |
| `originStops` | `Vec<u32>` | Yes | Resident timetable stop indices for origin candidates. |
| `originWalkSeconds` | `Vec<f64>` | Yes | Access seconds parallel to origin stop candidates. |
| `originCandidateIndices` | `Vec<u32>` | Yes | Caller candidate identities used in origin witness references. |
| `destinationStops` | `Vec<u32>` | Yes | Resident timetable stop indices for destination candidates. |
| `destinationWalkSeconds` | `Vec<f64>` | Yes | Egress seconds parallel to destination stop candidates. |
| `destinationCandidateIndices` | `Vec<u32>` | Yes | Caller candidate identities used in destination witness references. |
| `earliest` | `f64` | Yes | Earliest permitted search clock in service-day seconds. |
| `deadline` | `f64` | Yes | Arrival deadline in service-day seconds. |
| `allowPreRideTransfers` | `bool` | Yes | Allow transfer-graph movement before first boarding; per-origin arrays for grouped queries. |
| `allowPostRideTransfers` | `Option<bool>` | No | Allow transfer-graph movement after the last ride; per-destination arrays where typed. |
| `maximumBoardings` | `Option<u32>` | No | Vehicle boarding cap, one larger than a transfer cap. |

## TimetableArriveByQueryResult

Source: `native/vigo-routing-kernel/src/timetable.rs`.

| JSON field | Rust / JSON type | Present | Meaning |
| --- | --- | --- | --- |
| `supported` | `bool` | Always | — |
| `status` | `String` | Always | — |
| `reason` | `Option<String>` | Always | — |
| `latestDeparture` | `Option<f64>` | Always | Selected departure clock in service-day seconds, or null when no departure is available. |
| `candidateCount` | `u32` | Always | — |
| `verifiedCandidates` | `u32` | Always | — |
| `queryNs` | `f64` | Always | Native query time in nanoseconds; excludes outer transport work. |
| `engineQueryNs` | `f64` | Always | — |
| `scannedDepartures` | `u32` | Always | — |
| `relaxedStops` | `u32` | Always | — |
| `expandedTripRuns` | `u32` | Always | — |
| `dominatedTripBoardings` | `u32` | Always | — |
| `explicitTransferChecks` | `u32` | Always | — |

## TimetableManyQueryInput

Source: `native/vigo-routing-kernel/src/timetable.rs`.

| JSON field | Rust / JSON type | Required | Meaning |
| --- | --- | --- | --- |
| `originStops` | `Vec<u32>` | Yes | Resident timetable stop indices for origin candidates. |
| `originWalkSeconds` | `Vec<f64>` | Yes | Access seconds parallel to origin stop candidates. |
| `destinationOffsets` | `Vec<u32>` | Yes | Cumulative boundaries grouping packed destination candidates; starts at zero. |
| `destinationStops` | `Vec<u32>` | Yes | Resident timetable stop indices for destination candidates. |
| `destinationWalkSeconds` | `Vec<f64>` | Yes | Egress seconds parallel to destination stop candidates. |
| `excludedTrips` | `Vec<u32>` | Yes | Active trip indices to exclude from this query. |
| `departure` | `f64` | Yes | Earliest departure clock in service-day seconds. |
| `horizon` | `f64` | Yes | Latest scan clock in service-day seconds, not a duration. |
| `allowPreRideTransfers` | `bool` | Yes | Allow transfer-graph movement before first boarding; per-origin arrays for grouped queries. |
| `allowPostRideTransfers` | `Option<Vec<bool>>` | No | Allow transfer-graph movement after the last ride; per-destination arrays where typed. |
| `maximumBoardings` | `Option<u32>` | No | Vehicle boarding cap, one larger than a transfer cap. |

## TimetableManyQueryResult

Source: `native/vigo-routing-kernel/src/timetable.rs`.

| JSON field | Rust / JSON type | Present | Meaning |
| --- | --- | --- | --- |
| `supported` | `bool` | Always | — |
| `status` | `String` | Always | — |
| `reason` | `Option<String>` | Always | — |
| `algorithm` | `String` | Always | — |
| `bestArrivals` | `Vec<f64>` | Always | Earliest arrival clocks in service-day seconds, in destination-group order. Null marks an unreachable destination. |
| `bestDestinationIndex` | `Option<u32>` | Always | — |
| `chainKinds` | `Vec<u32>` | Always | — |
| `chainFromStops` | `Vec<i32>` | Always | — |
| `chainToStops` | `Vec<i32>` | Always | — |
| `chainTripOrCandidate` | `Vec<i32>` | Always | — |
| `chainBoardSequences` | `Vec<f64>` | Always | — |
| `chainAlightSequences` | `Vec<f64>` | Always | — |
| `chainDurations` | `Vec<u32>` | Always | — |
| `chainArrivals` | `Vec<f64>` | Always | — |
| `queryNs` | `f64` | Always | Native query time in nanoseconds; excludes outer transport work. |
| `scannedDepartures` | `u32` | Always | — |
| `excludedDepartures` | `u32` | Always | — |
| `relaxedStops` | `u32` | Always | — |
| `expandedTripRuns` | `u32` | Always | — |
| `dominatedTripBoardings` | `u32` | Always | — |
| `explicitTransferChecks` | `u32` | Always | — |

## TimetableMatrixJourney

Source: `native/vigo-routing-kernel/src/timetable/journeys.rs`.

| JSON field | Rust / JSON type | Present | Meaning |
| --- | --- | --- | --- |
| `departure` | `f64` | Always | Earliest departure clock in service-day seconds. |
| `arrival` | `f64` | Always | — |
| `boardings` | `u32` | Always | — |
| `walkingSeconds` | `f64` | Always | — |
| `rideSeconds` | `f64` | Always | — |
| `waitingSeconds` | `f64` | Always | — |
| `legs` | `Vec<TimetableMatrixLeg>` | Always | — |

## TimetableMatrixLeg

Source: `native/vigo-routing-kernel/src/timetable/journeys.rs`.

| JSON field | Rust / JSON type | Present | Meaning |
| --- | --- | --- | --- |
| `kind` | `String` | Always | — |
| `fromStop` | `Option<u32>` | Always | — |
| `toStop` | `Option<u32>` | Always | — |
| `trip` | `Option<u32>` | Always | — |
| `boardSequence` | `Option<f64>` | Always | — |
| `alightSequence` | `Option<f64>` | Always | — |
| `departure` | `f64` | Always | Earliest departure clock in service-day seconds. |
| `arrival` | `f64` | Always | — |

## TimetableMatrixQueryInput

Source: `native/vigo-routing-kernel/src/timetable.rs`.

| JSON field | Rust / JSON type | Required | Meaning |
| --- | --- | --- | --- |
| `originOffsets` | `Vec<u32>` | Yes | Cumulative boundaries grouping packed origin candidates; starts at zero. |
| `originStops` | `Vec<u32>` | Yes | Resident timetable stop indices for origin candidates. |
| `originWalkSeconds` | `Vec<f64>` | Yes | Access seconds parallel to origin stop candidates. |
| `allowPreRideTransfers` | `Vec<bool>` | Yes | Allow transfer-graph movement before first boarding; per-origin arrays for grouped queries. |
| `destinationOffsets` | `Vec<u32>` | Yes | Cumulative boundaries grouping packed destination candidates; starts at zero. |
| `destinationStops` | `Vec<u32>` | Yes | Resident timetable stop indices for destination candidates. |
| `destinationWalkSeconds` | `Vec<f64>` | Yes | Egress seconds parallel to destination stop candidates. |
| `departure` | `f64` | Yes | Depart-at: shared departure clock. Arrive-by: earliest search clock. Measured in service-day seconds. |
| `horizon` | `f64` | Yes | Depart-at: latest scan clock. Arrive-by: shared arrival deadline. Measured in service-day seconds. |
| `arriveBy` | `bool` | Yes | Use reverse time direction and a shared arrival deadline. |
| `allowPostRideTransfers` | `Option<Vec<bool>>` | No | Allow transfer-graph movement after the last ride; per-destination arrays where typed. |
| `maximumBoardings` | `Option<u32>` | No | Vehicle boarding cap, one larger than a transfer cap. |
| `includeJourneys` | `Option<bool>` | No | Materialize compact native journey witnesses alongside matrix times. |

## TimetableMatrixQueryResult

Source: `native/vigo-routing-kernel/src/timetable.rs`.

| JSON field | Rust / JSON type | Present | Meaning |
| --- | --- | --- | --- |
| `times` | `Vec<f64>` | Always | Flat origin-major matrix of service-day clocks in seconds: arrivals for depart-at, departures for arrive-by. Null marks an unreachable pair. These are not travel durations. |
| `journeys` | `Option<Vec<Option<TimetableMatrixJourney>>>` | Always | Journey records in the same order as times. Null when journeys were not requested; individual null entries mark pairs without a journey. |
| `forwardSearches` | `u32` | Always | — |
| `reverseSearches` | `u32` | Always | — |
| `queryNs` | `f64` | Always | Native query time in nanoseconds; excludes outer transport work. |
| `scannedDepartures` | `f64` | Always | — |
| `relaxedStops` | `f64` | Always | — |
| `expandedTripRuns` | `f64` | Always | — |
| `dominatedTripBoardings` | `f64` | Always | — |
| `explicitTransferChecks` | `f64` | Always | — |

## TimetableOverlayManyQueryInput

Source: `native/vigo-routing-kernel/src/timetable.rs`.

| JSON field | Rust / JSON type | Required | Meaning |
| --- | --- | --- | --- |
| `originStops` | `Vec<u32>` | Yes | Resident timetable stop indices for origin candidates. |
| `originWalkSeconds` | `Vec<f64>` | Yes | Access seconds parallel to origin stop candidates. |
| `destinationOffsets` | `Vec<u32>` | Yes | Cumulative boundaries grouping packed destination candidates; starts at zero. |
| `destinationStops` | `Vec<u32>` | Yes | Resident timetable stop indices for destination candidates. |
| `destinationWalkSeconds` | `Vec<f64>` | Yes | Egress seconds parallel to destination stop candidates. |
| `excludedTrips` | `Vec<u32>` | Yes | Active trip indices to exclude from this query. |
| `departure` | `f64` | Yes | Earliest departure clock in service-day seconds. |
| `horizon` | `f64` | Yes | Latest scan clock in service-day seconds, not a duration. |
| `allowPreRideTransfers` | `bool` | Yes | Allow transfer-graph movement before first boarding; per-origin arrays for grouped queries. |
| `overlayStopCount` | `u32` | Yes | Number of overlay-local stops appended to the resident domain. |
| `overlayBaseStops` | `Option<Vec<i32>>` | No | Resident identity for each overlay stop, or -1 for a new scenario stop. Realtime replacements inherit the original station's transfer rules. |
| `directionOffsets` | `Vec<u32>` | Yes | Cumulative boundaries grouping each planned direction/run stop list. |
| `directionStops` | `Vec<u32>` | Yes | Packed stop indices in the overlay-local domain. |
| `directionStopOffsetsSeconds` | `Vec<f64>` | Yes | Departure offsets from each planned run start. |
| `directionArrivalOffsetsSeconds` | `Option<Vec<f64>>` | No | Optional arrival offsets preserve dwell time in realtime replacements. Frequency scenarios without this field retain their existing offsets. |
| `serviceStartSeconds` | `Vec<f64>` | Yes | First run departure clock for each planned direction. |
| `serviceEndSeconds` | `Vec<f64>` | Yes | Last allowed run departure clock for each planned direction. |
| `serviceHeadwaySeconds` | `Vec<f64>` | Yes | Positive spacing between generated run departures. |
| `supplementalTransferOffsets` | `Vec<u32>` | Yes | Cumulative transfer boundaries for the combined resident-plus-overlay stop domain. |
| `supplementalTransferTo` | `Vec<u32>` | Yes | Transfer target indices in the combined stop domain. |
| `supplementalTransferDuration` | `Vec<u32>` | Yes | Supplemental transfer durations in seconds. |
| `originCandidateIndices` | `Option<Vec<u32>>` | No | Caller candidate identities used in origin witness references. |
| `destinationCandidateIndices` | `Option<Vec<u32>>` | No | Caller candidate identities used in destination witness references. |
| `directionCanBoard` | `Option<Vec<u8>>` | No | — |
| `directionCanAlight` | `Option<Vec<u8>>` | No | — |
| `allowPostRideTransfers` | `Option<Vec<bool>>` | No | Allow transfer-graph movement after the last ride; per-destination arrays where typed. |
| `maximumBoardings` | `Option<u32>` | No | Vehicle boarding cap, one larger than a transfer cap. |
| `certifyJourney` | `Option<bool>` | No | Certify secondary objectives for a single journey, without charging matrix/scenario callers for itinerary ranking. |

## TimetableOverlayManyQueryResult

Source: `native/vigo-routing-kernel/src/timetable.rs`.

| JSON field | Rust / JSON type | Present | Meaning |
| --- | --- | --- | --- |
| `timetable` | `TimetableManyQueryResult` | Always | — |
| `overlayConnections` | `u32` | Always | — |
| `overlayRuns` | `u32` | Always | — |
| `overlayRunDirections` | `Vec<u32>` | Always | Input direction for each query-local run. Expired directions may emit no runs and frequency directions may emit several. |
| `supplementalTransferEdges` | `u32` | Always | — |
| `compileNs` | `f64` | Always | — |
| `scanNs` | `f64` | Always | — |
| `transientBytes` | `f64` | Always | — |
| `workspaceBytes` | `f64` | Always | — |
| `lexicographicCertified` | `bool` | Always | — |
| `qualityQueryNs` | `f64` | Always | — |
| `qualityBytes` | `f64` | Always | — |
| `qualityReason` | `Option<String>` | Always | — |

## TimetableParetoAlternative

Source: `native/vigo-routing-kernel/src/timetable.rs`.

| JSON field | Rust / JSON type | Present | Meaning |
| --- | --- | --- | --- |
| `bestArrival` | `f64` | Always | — |
| `bestBoardings` | `u32` | Always | — |
| `bestDestinationIndex` | `u32` | Always | — |
| `bestWalkingSeconds` | `f64` | Always | — |
| `chainKinds` | `Vec<u32>` | Always | — |
| `chainFromStops` | `Vec<i32>` | Always | — |
| `chainToStops` | `Vec<i32>` | Always | — |
| `chainTripOrCandidate` | `Vec<i32>` | Always | — |
| `chainBoardSequences` | `Vec<f64>` | Always | — |
| `chainAlightSequences` | `Vec<f64>` | Always | — |
| `chainDurations` | `Vec<u32>` | Always | — |
| `chainArrivals` | `Vec<f64>` | Always | — |

## TimetableParetoQueryInput

Source: `native/vigo-routing-kernel/src/timetable.rs`.

| JSON field | Rust / JSON type | Required | Meaning |
| --- | --- | --- | --- |
| `originStops` | `Vec<u32>` | Yes | Resident timetable stop indices for origin candidates. |
| `originWalkSeconds` | `Vec<f64>` | Yes | Access seconds parallel to origin stop candidates. |
| `originCandidateIndices` | `Vec<u32>` | Yes | Caller candidate identities used in origin witness references. |
| `destinationStops` | `Vec<u32>` | Yes | Resident timetable stop indices for destination candidates. |
| `destinationWalkSeconds` | `Vec<f64>` | Yes | Egress seconds parallel to destination stop candidates. |
| `destinationCandidateIndices` | `Vec<u32>` | Yes | Caller candidate identities used in destination witness references. |
| `departure` | `f64` | Yes | Earliest departure clock in service-day seconds. |
| `horizon` | `f64` | Yes | Latest scan clock in service-day seconds, not a duration. |
| `allowPreRideTransfers` | `bool` | Yes | Allow transfer-graph movement before first boarding; per-origin arrays for grouped queries. |
| `earliestArrival` | `f64` | Yes | Reference earliest arrival clock for Pareto bounds, in seconds. |
| `boardingUpperBound` | `u32` | Yes | Maximum boarding count considered by the Pareto search. |
| `candidateDestinationIndex` | `u32` | Yes | Reference candidate destination identity for Pareto certification. |
| `candidateWalkingSeconds` | `f64` | Yes | Walking time of the candidate being certified. |
| `arrivalSlackSeconds` | `f64` | Yes | Permitted arrival slack relative to the supplied reference arrival. |
| `transferPenaltySeconds` | `f64` | Yes | Generalized-cost penalty associated with additional boardings. |
| `walkReluctance` | `f64` | Yes | Walking cost multiplier used by the native Pareto objective. |
| `collectAlternatives` | `Option<bool>` | No | Return arrival/boarding/walking trade-offs inside the supplied bounds. |
| `restrictionMode` | `Option<String>` | No | Optional exact corridor restriction mode used by the production Pareto certifier. |
| `allowPostRideTransfers` | `Option<bool>` | No | Allow transfer-graph movement after the last ride; per-destination arrays where typed. |
| `deadlineObjective` | `Option<bool>` | No | At a fixed latest departure, minimize boardings, then walking, then arrival, subject to the supplied hard arrival bound. |

## TimetableParetoQueryResult

Source: `native/vigo-routing-kernel/src/timetable.rs`.

| JSON field | Rust / JSON type | Present | Meaning |
| --- | --- | --- | --- |
| `supported` | `bool` | Always | — |
| `status` | `String` | Always | — |
| `reason` | `Option<String>` | Always | — |
| `bestArrival` | `Option<f64>` | Always | — |
| `bestBoardings` | `Option<u32>` | Always | — |
| `bestDestinationIndex` | `Option<u32>` | Always | — |
| `bestWalkingSeconds` | `Option<f64>` | Always | — |
| `bestGeneralizedSeconds` | `Option<f64>` | Always | — |
| `improvedCandidate` | `bool` | Always | — |
| `alternatives` | `Option<Vec<TimetableParetoAlternative>>` | Always | — |
| `chainKinds` | `Vec<u32>` | Always | — |
| `chainFromStops` | `Vec<i32>` | Always | — |
| `chainToStops` | `Vec<i32>` | Always | — |
| `chainTripOrCandidate` | `Vec<i32>` | Always | — |
| `chainBoardSequences` | `Vec<f64>` | Always | — |
| `chainAlightSequences` | `Vec<f64>` | Always | — |
| `chainDurations` | `Vec<u32>` | Always | — |
| `chainArrivals` | `Vec<f64>` | Always | — |
| `queryNs` | `f64` | Always | Native query time in nanoseconds; excludes outer transport work. |
| `corridorNs` | `f64` | Always | — |
| `forwardNs` | `f64` | Always | — |
| `reverseNs` | `f64` | Always | — |
| `roundNs` | `f64` | Always | — |
| `corridorExitEvents` | `f64` | Always | — |
| `corridorRunSegments` | `f64` | Always | — |
| `corridorTransferEdges` | `f64` | Always | — |
| `forwardDepartureEvents` | `f64` | Always | — |
| `forwardRunSegments` | `f64` | Always | — |
| `forwardTransferEdges` | `f64` | Always | — |
| `scannedDepartures` | `u32` | Always | — |
| `relaxedStops` | `u32` | Always | — |
| `expandedTripRuns` | `u32` | Always | — |
| `dominatedTripBoardings` | `u32` | Always | — |
| `explicitTransferChecks` | `u32` | Always | — |
| `dominatedCandidateLabels` | `u32` | Always | — |
| `dominatedExistingLabels` | `u32` | Always | — |
| `terminalCandidatesEvaluated` | `u32` | Always | — |
| `paretoLabels` | `u32` | Always | — |
| `runProfiles` | `u32` | Always | — |
| `restrictionMode` | `String` | Always | — |
| `forwardRestrictionApplied` | `bool` | Always | — |
| `reverseRestrictionApplied` | `bool` | Always | — |
| `scalarEnvelopeReused` | `bool` | Always | — |
| `forwardEnvelopeBuilt` | `bool` | Always | — |
| `reverseCorridorBuilt` | `bool` | Always | — |
| `retainedRunLayerMemberships` | `f64` | Always | — |
| `totalRunLayerMemberships` | `f64` | Always | — |
| `retainedSegmentLayerMemberships` | `f64` | Always | — |
| `totalSegmentLayerMemberships` | `f64` | Always | — |
| `retainedStopDeadlineMemberships` | `f64` | Always | — |
| `totalStopDeadlineMemberships` | `f64` | Always | — |
| `retainedUniqueRuns` | `u32` | Always | — |
| `restrictionBytes` | `f64` | Always | — |
| `labelBytes` | `f64` | Always | — |

## TimetableQueryInput

Source: `native/vigo-routing-kernel/src/timetable.rs`.

| JSON field | Rust / JSON type | Required | Meaning |
| --- | --- | --- | --- |
| `originStops` | `Vec<u32>` | Yes | Resident timetable stop indices for origin candidates. |
| `originWalkSeconds` | `Vec<f64>` | Yes | Access seconds parallel to origin stop candidates. |
| `originCandidateIndices` | `Vec<u32>` | Yes | Caller candidate identities used in origin witness references. |
| `destinationStops` | `Vec<u32>` | Yes | Resident timetable stop indices for destination candidates. |
| `destinationWalkSeconds` | `Vec<f64>` | Yes | Egress seconds parallel to destination stop candidates. |
| `destinationCandidateIndices` | `Vec<u32>` | Yes | Caller candidate identities used in destination witness references. |
| `departure` | `f64` | Yes | Earliest departure clock in service-day seconds. |
| `horizon` | `f64` | Yes | Latest scan clock in service-day seconds, not a duration. |
| `allowPreRideTransfers` | `bool` | Yes | Allow transfer-graph movement before first boarding; per-origin arrays for grouped queries. |
| `allowPostRideTransfers` | `Option<bool>` | No | Allow transfer-graph movement after the last ride; per-destination arrays where typed. |
| `maximumBoardings` | `Option<u32>` | No | Vehicle boarding cap, one larger than a transfer cap. |

## TimetableQueryResult

Source: `native/vigo-routing-kernel/src/timetable.rs`.

| JSON field | Rust / JSON type | Present | Meaning |
| --- | --- | --- | --- |
| `supported` | `bool` | Always | — |
| `status` | `String` | Always | — |
| `reason` | `Option<String>` | Always | — |
| `bestArrival` | `Option<f64>` | Always | Selected arrival clock in service-day seconds, or null when no arrival is available. |
| `bestBoardings` | `Option<u32>` | Always | — |
| `bestDestinationIndex` | `Option<u32>` | Always | — |
| `chainKinds` | `Vec<u32>` | Always | — |
| `chainFromStops` | `Vec<i32>` | Always | — |
| `chainToStops` | `Vec<i32>` | Always | — |
| `chainTripOrCandidate` | `Vec<i32>` | Always | — |
| `chainBoardSequences` | `Vec<f64>` | Always | — |
| `chainAlightSequences` | `Vec<f64>` | Always | — |
| `chainDurations` | `Vec<u32>` | Always | — |
| `chainArrivals` | `Vec<f64>` | Always | — |
| `queryNs` | `f64` | Always | Native query time in nanoseconds; excludes outer transport work. |
| `destinationSeedNs` | `f64` | Always | — |
| `originSeedNs` | `f64` | Always | — |
| `scanNs` | `f64` | Always | — |
| `chainNs` | `f64` | Always | — |
| `poppedStates` | `u32` | Always | — |
| `scannedDepartures` | `u32` | Always | — |
| `relaxedStops` | `u32` | Always | — |
| `expandedTripRuns` | `u32` | Always | — |
| `dominatedTripBoardings` | `u32` | Always | — |
| `explicitTransferChecks` | `u32` | Always | — |
