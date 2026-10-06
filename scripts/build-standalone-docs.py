#!/usr/bin/env python3
"""Generate the offline Rust manual and OpenAPI contracts using only the standard library."""
import argparse
import base64
import html
import json
from pathlib import Path
import re

ROOT = Path(__file__).resolve().parent.parent
SOURCE = ROOT / 'docs/guides/rust-standalone.md'
VERSION = json.loads((ROOT / 'package.json').read_text(encoding='utf-8'))['version']
OPERATIONS = {
    'timetable.route': ('TimetableQueryInput', 'TimetableQueryResult'),
    'timetable.arrive_by': ('TimetableArriveByQueryInput', 'TimetableArriveByQueryResult'),
    'timetable.matrix': ('TimetableMatrixQueryInput', 'TimetableMatrixQueryResult'),
    'timetable.many': ('TimetableManyQueryInput', 'TimetableManyQueryResult'),
    'timetable.arrive_by_many': ('TimetableArriveByManyQueryInput', 'TimetableArriveByManyQueryResult'),
    'timetable.pareto': ('TimetableParetoQueryInput', 'TimetableParetoQueryResult'),
    'timetable.overlay': ('TimetableOverlayManyQueryInput', 'TimetableOverlayManyQueryResult'),
    'access.endpoint': ('EndpointRoleInput', 'EndpointRoleResult'),
    'access.endpoints': ('EndpointRouteInput', 'EndpointRouteResult'),
    'street.path': ('StreetPathInput', 'StreetPathResult'),
    'street.matrix': ('StreetMatrixInput', 'StreetMatrixResult'),
    'street.surface': ('StreetSurfaceInput', 'StreetSurfaceResult'),
    'street.connectors': ('TimedConnectorInput', 'TimedConnectorResult'),
    'drive.route': ('DriveQueryInput', 'DriveQueryResult'),
    'drive.matrix': ('DriveMatrixInput', 'DriveMatrixResult'),
    'realtime.compile': ('RealtimeTimetableInput', 'RealtimeTimetableResult'),
}


def ref(name):
    return {'$ref': '#/components/schemas/' + name}


def obj(properties, required=(), strict=True, **extra):
    return {'type': 'object', 'properties': properties, 'required': list(required), 'additionalProperties': not strict, **extra}


def number(low=None, high=None, default=None, integer=False, description=None):
    result = {'type': 'integer' if integer else 'number'}
    for key, value in [('minimum', low), ('maximum', high), ('default', default), ('description', description)]:
        if value is not None:
            result[key] = value
    return result


def array(items, low=None, high=None):
    return {'type': 'array', 'items': items, **({'minItems': low} if low is not None else {}), **({'maxItems': high} if high is not None else {})}


def text(*values, default=None, description=None):
    return {'type': 'string', **({'enum': list(values)} if values else {}), **({'default': default} if default is not None else {}), **({'description': description} if description else {})}


def boolean(default=False):
    return {'type': 'boolean', 'default': default}


def camel(value):
    return re.sub(r'_([a-z])', lambda m: m[1].upper(), value)


FIELD_NOTES = {
    'role': 'Endpoint direction: origin or destination; directed walking access and egress differ.',
    'longitude': 'WGS84 longitude in degrees.', 'latitude': 'WGS84 latitude in degrees.',
    'origin_lon': 'Origin longitude in degrees.', 'origin_lat': 'Origin latitude in degrees.',
    'destination_lon': 'Destination longitude in degrees.', 'destination_lat': 'Destination latitude in degrees.',
    'walking_speed_kph': 'Walking speed in kilometers per hour; omission uses the prepared policy.',
    'walk_speed_kph': 'Walking speed in kilometers per hour.',
    'access_padding_factor': 'Multiplier applied to transit endpoint walking time.',
    'access_overhead_seconds': 'Fixed transit endpoint access overhead in seconds.',
    'maximum_walk_m': 'Maximum endpoint or terminal walking distance in meters.',
    'maximum_distance_m': 'Maximum street path distance in meters.',
    'maximum_distance_meters': 'Maximum drive path distance in meters.',
    'maximum_points': 'Maximum number of returned path geometry points.',
    'disable_cache': 'Disable endpoint cache reuse for this call.',
    'origin_coordinates': 'Flat longitude/latitude pairs in origin row order.',
    'destination_coordinates': 'Flat longitude/latitude pairs in destination column order.',
    'target_coordinates': 'Flat longitude/latitude pairs in target order.',
    'seed_coordinates': 'Flat longitude/latitude pairs for surface/connector seeds.',
    'seed_durations_minutes': 'Elapsed minutes already spent reaching each seed.',
    'seed_maximum_walk_m': 'Per-seed remaining walking allowance in meters.',
    'seed_indices': 'Caller seed identities, parallel to seed coordinate pairs.',
    'default_maximum_walk_m': 'Default walking allowance in meters.',
    'maximum_duration_minutes': 'Maximum elapsed duration accepted by the surface/connector query.',
    'include_target_matrix': 'Include the seed-to-target connector matrix.',
    'bounds': 'Geographic bounds in west, south, east, north order.',
    'width': 'Number of raster columns.', 'height': 'Number of raster rows.',
    'include_nodes': 'Return native reached-node evidence.', 'include_edges': 'Return native directed-edge evidence.',
    'node_evidence_limit': 'Node evidence cap, clamped to 1..100000; zero therefore returns at most one node.',
    'edge_evidence_limit': 'Edge evidence cap; zero means no caller truncation limit.',
    'expand_bounds_to_reached_edges': 'Also construct a raster with bounds derived from reached street evidence; these bounds need not contain the requested bounds.',
    'origin_stops': 'Resident timetable stop indices for origin candidates.',
    'destination_stops': 'Resident timetable stop indices for destination candidates.',
    'origin_walk_seconds': 'Access seconds parallel to origin stop candidates.',
    'destination_walk_seconds': 'Egress seconds parallel to destination stop candidates.',
    'origin_candidate_indices': 'Caller candidate identities used in origin witness references.',
    'destination_candidate_indices': 'Caller candidate identities used in destination witness references.',
    'origin_offsets': 'Cumulative boundaries grouping packed origin candidates; starts at zero.',
    'destination_offsets': 'Cumulative boundaries grouping packed destination candidates; starts at zero.',
    'target_offsets': 'Cumulative boundaries grouping packed drive target candidates.',
    'departure': 'Earliest departure clock in service-day seconds.',
    'horizon': 'Latest scan clock in service-day seconds, not a duration.',
    'earliest': 'Earliest permitted search clock in service-day seconds.',
    'deadline': 'Arrival deadline in service-day seconds.',
    'arrive_by': 'Use reverse time direction and a shared arrival deadline.',
    'allow_pre_ride_transfers': 'Allow transfer-graph movement before first boarding; per-origin arrays for grouped queries.',
    'allow_post_ride_transfers': 'Allow transfer-graph movement after the last ride; per-destination arrays where typed.',
    'maximum_boardings': 'Vehicle boarding cap, one larger than a transfer cap.',
    'excluded_trips': 'Active trip indices to exclude from this query.',
    'include_journeys': 'Materialize compact native journey witnesses alongside matrix times.',
    'earliest_arrival': 'Reference earliest arrival clock for Pareto bounds, in seconds.',
    'boarding_upper_bound': 'Maximum boarding count considered by the Pareto search.',
    'candidate_destination_index': 'Reference candidate destination identity for Pareto certification.',
    'candidate_walking_seconds': 'Walking time of the candidate being certified.',
    'arrival_slack_seconds': 'Permitted arrival slack relative to the supplied reference arrival.',
    'transfer_penalty_seconds': 'Generalized-cost penalty associated with additional boardings.',
    'walk_reluctance': 'Walking cost multiplier used by the native Pareto objective.',
    'origin_nodes': 'Drive-graph candidate node indices for origins.',
    'target_nodes': 'Drive-graph candidate node indices for destinations.',
    'origin_snap_meters': 'Origin snap distances in meters, parallel to candidate nodes.',
    'target_snap_meters': 'Destination snap distances in meters, parallel to candidate nodes.',
    'traffic': 'Optional directed drive-edge metric updates.',
    'snapshot_key': 'Caller metric identity; the standalone adapter binds caches to actual weights.',
    'edge_indices': 'Directed edge indices in the active drive graph.',
    'edge_time_units': 'Weights in hundredths of seconds; 2147483647 closes an edge.',
    'overlay_stop_count': 'Number of overlay-local stops appended to the resident domain.',
    'direction_offsets': 'Cumulative boundaries grouping each planned direction/run stop list.',
    'direction_stops': 'Packed stop indices in the overlay-local domain.',
    'direction_stop_offsets_seconds': 'Departure offsets from each planned run start.',
    'service_start_seconds': 'First run departure clock for each planned direction.',
    'service_end_seconds': 'Last allowed run departure clock for each planned direction.',
    'service_headway_seconds': 'Positive spacing between generated run departures.',
    'supplemental_transfer_offsets': 'Cumulative transfer boundaries for the combined resident-plus-overlay stop domain.',
    'supplemental_transfer_to': 'Transfer target indices in the combined stop domain.',
    'supplemental_transfer_duration': 'Supplemental transfer durations in seconds.',
    'canceled': 'Per-trip cancellation flags in the supplied baseline timetable.',
    'replacements': 'Explicit effective calls replacing identified baseline trips.',
    'query_ns': 'Native query time in nanoseconds; excludes outer transport work.',
}

TYPE_FIELD_NOTES = {
    ('DriveQueryResult', 'origin_snap_meters'): 'Distance in meters from the selected origin point to the drive graph.',
    ('DriveQueryResult', 'target_snap_meters'): 'Distance in meters from the drive graph to the selected destination point.',
    ('DriveQueryResult', 'distance_meters'): 'Selected drive-path distance in meters.',
    ('DriveQueryResult', 'duration_seconds'): 'Selected drive-path duration in seconds.',
    ('DriveQueryResult', 'node_indices'): 'Ordered node indices in the active drive graph for the selected path.',
    ('DriveMatrixResult', 'distances_m'): 'Flat origin-major matrix of distances in meters; null marks an unreachable pair.',
    ('DriveMatrixResult', 'durations_s'): 'Flat origin-major matrix of travel durations in seconds; null marks an unreachable pair.',
    ('StreetPathResult', 'coordinates'): 'Flat longitude/latitude pairs describing the returned path.',
    ('StreetPathResult', 'distance_m'): 'Returned path distance in meters.',
    ('StreetMatrixResult', 'distances_m'): 'Flat origin-major matrix of directed street distances in meters; null marks an unreachable pair.',
    ('TimetableMatrixQueryInput', 'departure'): 'Depart-at: shared departure clock. Arrive-by: earliest search clock. Measured in service-day seconds.',
    ('TimetableMatrixQueryInput', 'horizon'): 'Depart-at: latest scan clock. Arrive-by: shared arrival deadline. Measured in service-day seconds.',
    ('TimetableMatrixQueryResult', 'times'): 'Flat origin-major matrix of service-day clocks in seconds: arrivals for depart-at, departures for arrive-by. Null marks an unreachable pair. These are not travel durations.',
    ('TimetableMatrixQueryResult', 'journeys'): 'Journey records in the same order as times. Null when journeys were not requested; individual null entries mark pairs without a journey.',
    ('TimetableManyQueryResult', 'best_arrivals'): 'Earliest arrival clocks in service-day seconds, in destination-group order. Null marks an unreachable destination.',
    ('TimetableArriveByManyQueryResult', 'latest_departures'): 'Latest departure clocks in service-day seconds, in origin-group order. Null marks an unreachable origin.',
    ('TimetableQueryResult', 'best_arrival'): 'Selected arrival clock in service-day seconds, or null when no arrival is available.',
    ('TimetableArriveByQueryResult', 'latest_departure'): 'Selected departure clock in service-day seconds, or null when no departure is available.',
    ('StreetSurfaceResult', 'values'): 'Elapsed minutes on the requested raster, flattened by row from the northwest corner. Null marks an unreached cell.',
    ('StreetSurfaceResult', 'full_surface_values'): 'Elapsed minutes on the recomputed raster, using fullSurfaceBounds and the requested dimensions. Null when no separate raster is returned.',
    ('StreetSurfaceResult', 'full_surface_bounds'): 'Recomputed raster bounds in west, south, east, north order; can be smaller or larger than requested. Null when no separate raster is returned.',
    ('StreetSurfaceResult', 'edge_evidence_durations'): 'Elapsed minutes to each retained directed edge to-endpoint, not the duration of that edge alone.',
    ('StreetSurfaceResult', 'edge_evidence_transit_arrivals'): 'Elapsed seed duration for each indexed edge; -1 marks seed index zero.',
    ('StreetSurfaceResult', 'node_evidence_truncated'): 'True when reached-node samples exceeded nodeEvidenceLimit after clamping.',
}


def native_contracts():
    structs = {}
    for path in sorted((ROOT / 'native/vigo-routing-kernel/src').rglob('*.rs')):
        for match in re.finditer(r'pub struct (\w+)\s*\{([^}]+)\}', path.read_text(encoding='utf-8')):
            fields, comments = [], []
            for line in match[2].splitlines():
                if line.strip().startswith('///'):
                    comments.append(line.strip()[3:].strip())
                field = re.match(r'\s*pub (\w+):\s*(.+),\s*$', line)
                if field:
                    fields.append((field[1], field[2], ' '.join(comments)))
                    comments = []
            structs[match[1]] = (fields, path.relative_to(ROOT).as_posix())
    schemas, directions = {}, {}
    def kind(value, output):
        if value.startswith('Option<'):
            return {'anyOf': [kind(value[7:-1], output), {'type': 'null'}]}
        if value.startswith('Vec<'):
            return array(kind(value[4:-1], output))
        aliases = {'Float64Array': 'f64', 'Uint32Array': 'u32', 'Uint8Array': 'u8', 'Int32Array': 'i32', 'Uint16Array': 'u16', 'Float32Array': 'f32'}
        if value in aliases:
            return array(kind(aliases[value], output))
        if value in ('f64', 'f32'):
            return {'type': ['number', 'null'] if output else 'number'}
        if value in ('u8', 'u16', 'u32', 'i32', 'u64', 'i64', 'usize'):
            limits = {'u8': (0,255), 'u16': (0,65535), 'u32': (0,4294967295), 'i32': (-2147483648,2147483647)}
            bounds = limits.get(value, (0 if value.startswith('u') else None, None))
            return number(*bounds, integer=True)
        if value == 'bool': return {'type': 'boolean'}
        if value == 'String': return text()
        assert value in structs, f'Unhandled Rust JSON type: {value}'
        register(value, output)
        return ref(value)
    def register(name, output):
        if name in schemas:
            assert directions[name] == output, f'{name} needs separate input and output schemas'
            return
        fields, source = structs[name]
        directions[name] = output
        schemas[name] = {}
        properties = {}
        for field, typ, comment in fields:
            properties[camel(field)] = kind(typ, output)
            description = comment or TYPE_FIELD_NOTES.get((name, field)) or FIELD_NOTES.get(field)
            if description: properties[camel(field)]['description'] = description
        schemas[name] = obj(properties, [camel(field) for field, typ, _ in fields if output or not typ.startswith('Option<')], strict=False,
                            description=f'Generated from {source}. Native semantic validation also applies.')
    for request, response in OPERATIONS.values():
        register(request, False)
        register(response, True)
    lines = ['# Native Rust field reference', '', f'Generated for VIGO {VERSION} from public Rust structs. Regenerate with `npm run docs:standalone`.', '',
             'Use the [standalone manual](../guides/rust-standalone.md#18-native-operation-reference) for units, index domains, and examples. In requests, an optional field accepts omission or null. Result objects include every listed field; an unavailable optional value is null. Native arrays become JSON arrays, and non-finite result numbers become null. The runtime also checks compatible array lengths, indices, and values.', '',
             '| Operation | Input | Result |', '| --- | --- | --- |', '| `timetable.identifiers` | No input object | Active identifier arrays |']
    for op, (request, response) in OPERATIONS.items():
        lines.append(f'| `{op}` | [{request}](#{request.lower()}) | [{response}](#{response.lower()}) |')
    for name in sorted(schemas):
        fields, source = structs[name]
        presence = 'Present' if directions[name] else 'Required'
        lines += ['', f'## {name}', '', f'Source: `{source}`.', '', f'| JSON field | Rust / JSON type | {presence} | Meaning |', '| --- | --- | --- | --- |']
        for field, typ, comment in fields:
            description = comment or TYPE_FIELD_NOTES.get((name, field)) or FIELD_NOTES.get(field, '—')
            required = 'Always' if directions[name] else 'No' if typ.startswith('Option<') else 'Yes'
            lines.append(f'| `{camel(field)}` | `{typ}` | {required} | {description} |')
    return schemas, '\n'.join(lines) + '\n'


def specification(native):
    schemas = dict(native)
    coordinate = {'type':'array','prefixItems':[number(-180,180),number(-90,90)],'minItems':2,'maxItems':2,'items':False}
    schemas['Coordinate'] = coordinate
    point_properties = {'stop':obj({'feed':{'type':['string','null']},'id':text()},['id']), 'stopId':text(), 'coordinate':ref('Coordinate'), **{k:text() for k in ['id','name','label','source','editStatus','baselineStopId']}, 'baselineStopIndex':number(0,integer=True)}
    schemas['Point'] = {'oneOf':[ref('Coordinate'), obj(point_properties, anyOf=[{'required':['stop']},{'required':['stopId']},{'required':['coordinate']}])], 'description':'Selected stop overrides coordinate unless source is map; map points require coordinate.'}
    schemas['Clock'] = {'oneOf':[{'type':'string','pattern':r'^\d{1,2}:\d{1,2}(:\d{1,2})?$'},number(0,4319)], 'description':'Service-day HH:MM[:SS], hours 0..71, minutes/seconds 0..59; or numeric minutes.'}
    common = {
        'diagnostics':text('none','summary','profile','trace',default='none'), 'includeGeometry':boolean(), 'includeLimitations':boolean(),
        'kind':text(), 'id':{}, 'serviceDate':{'type':'string','format':'date'}, 'serviceDay':text('weekday','saturday','sunday'),
        'time':ref('Clock'), 'timeMinutes':number(0,4319), 'timePreference':text('depart_at','arrive_by','depart','arrive',default='depart_at'),
        'mode':text('transit','walk','drive',default='transit'), 'maxWalkKm':number(0,100,1.2), 'maxStreetKm':number(.05,1000,50),
        'maxTransfers':number(0,31,integer=True), 'horizonMinutes':number(1,2880,480), 'allowStreetTransfers':boolean(True),
        'minimumTransferBufferMinutes':number(0,60,0,integer=True), 'disableCache':boolean(), 'requireTransitRide':boolean(True),
        'allowLongWalk':boolean(True), 'walkSpeedKph':number(1,8,description='Default comes from the City. Walk Route/Matrix and Reach only.'),
        'requireCompleteServiceCoverage':boolean(), 'routingDataMode':text('scheduled','realtime'), 'dataMode':text('scheduled','realtime'),
    }
    clock_rule = {'oneOf':[{'required':['time']},{'required':['timeMinutes']}]}
    transit_date = {'if':{'properties':{'mode':{'const':'transit'}}},'then':{'required':['serviceDate']}}
    mode_rule = {'not':{'required':['routingDataMode','dataMode']}}
    event = obj({'time':number(0,integer=True),'delay':number(integer=True),'uncertainty':number(0)},strict=False)
    update = obj({'stopSequence':number(0,4294967295,integer=True),'stopId':text(),'scheduleRelationship':{'oneOf':[text('SCHEDULED','SKIPPED','NO_DATA'),number(0,2,integer=True)]},'arrival':event,'departure':event},strict=False,anyOf=[{'required':['stopSequence']},{'required':['stopId']}])
    schemas['RealtimeSnapshot'] = obj({'incrementality':{'enum':['FULL_DATASET',0]},'timezone':text(),'feedTimestamp':number(1,integer=True),
        'tripUpdates':array(obj({'tripId':text(),'trip':obj({'tripId':text(),'startDate':text()},strict=False),'startDate':text(),'sourceScope':text(),
        'routeId':text(),'directionId':{},'sourceFeedTimestamp':number(1,integer=True),'timestamp':number(1,integer=True),'delaySeconds':number(integer=True),
        'scheduleRelationship':{'enum':['SCHEDULED','CANCELED','DELETED',0,3,7]},'stopTimeUpdates':array(update)},strict=False),0,100000)},['tripUpdates'],strict=False,
        description='Timestamp freshness is checked at runtime. Invalid individual records retain scheduled service and report diagnostics.')
    timestamp = {'oneOf':[number(),{'type':'string','format':'date-time'}]}
    observation = obj({'coordinates':array(ref('Coordinate'),2,512),'fromCoordinate':ref('Coordinate'),'toCoordinate':ref('Coordinate'),
        'edgeIndices':array(number(0,integer=True)),'closed':boolean(),'travelTimeSeconds':number(.01,86400),'speedKph':number(1,200),
        'delayFactor':number(1,100),'factor':number(1,100),'multiplier':number(1,100)},strict=False,
        description='Directed geometry or edge indices and exactly one active cost effect; indices require the enclosing street fingerprint.')
    raw = obj({'snapshotKey':text(),'streetSourceFingerprint':text(),'edgeIndices':array(number(0,integer=True),0,200000),'edgeTimeUnits':array(number(0,2147483647,integer=True),0,200000)},['snapshotKey','streetSourceFingerprint','edgeIndices','edgeTimeUnits'],strict=False)
    observations = obj({'observedAt':timestamp,'fetchedAt':timestamp,'timestamp':timestamp,'expiresAt':timestamp,'ttlSeconds':number(1,1800,300),
        'streetSourceFingerprint':text(), **{k:array(observation,1,100000) for k in ['observations','segments','edgeUpdates']}},strict=False,
        allOf=[{'anyOf':[{'required':[k]} for k in ['observedAt','fetchedAt','timestamp']]},{'anyOf':[{'required':[k]} for k in ['observations','segments','edgeUpdates']]}])
    schemas['Traffic'] = {'oneOf':[raw,observations]}
    clock_common = {**common,'arrivalBufferMinutes':number(0,60,0,integer=True,description='Caller-selected arrival reserve. Positive values require arrive-by Transit Route/Matrix without via points; reserve the final minutes of the original horizon. Not a calibrated probability.'),'realtimeSnapshot':ref('RealtimeSnapshot'),'traffic':ref('Traffic')}
    schemas['RouteRequest'] = obj({**clock_common,'includeGeometry':boolean(True),'origin':ref('Point'),'destination':ref('Point'),'via':array(ref('Point'),0,16),'waypoints':array(ref('Point'),0,16),
        'windowMinutes':number(0,240,0),'windowStepMinutes':number(1,60,1)},['origin','destination'],allOf=[clock_rule,transit_date,mode_rule,{'not':{'required':['via','waypoints']}}],
        description='Additional mode constraints, source identities, freshness, and via/window combinations are validated by the runtime. Route includes available leg GeoJSON by default. Set includeGeometry: false to omit coordinate arrays. Geometry retains source precision and provenance; inferred station links remain labeled.')
    matrix_fields = {k:v for k,v in clock_common.items() if k!='realtimeSnapshot'}
    schemas['MatrixRequest'] = obj({**matrix_fields,'origins':array(ref('Point'),1,65536),'destinations':array(ref('Point'),1,65536),'includeJourneys':boolean(),'includeGeometry':boolean(), 'journeyFormat':{**text('full','compact'),'default':'full','description':'Requires transit includeJourneys. Compact retains the exact timed trip/stop/boarding witness, without display metadata or walking evidence; it cannot include geometry.'}},['origins','destinations'],allOf=[clock_rule,transit_date,mode_rule],description='At most 65536 pairs. Journeys require transit; geometry requires full journeys. No realtime transit.')
    scheduled = obj({'tripId':text(),'departureSeconds':number(0,1048575),'arrivalOffsetsSeconds':array(number(0)), 'departureOffsetsSeconds':array(number(0)),
        'canBoard':array(number(0,1,integer=True)),'canAlight':array(number(0,1,integer=True))},['departureSeconds','arrivalOffsetsSeconds','departureOffsetsSeconds'],strict=False)
    service = obj({'id':text(),'name':text(),'operation':text('add','augment','replace',default='add'),'stops':array(ref('Point'),2),
        'scheduleMode':text('frequency','preserve-trips'),'sourceRouteId':text(),'scheduledTrips':array(scheduled),'bidirectional':{'type':'boolean'},
        'startMinutes':number(0,4319,300),'endMinutes':number(0,4319,1500),'headwayMinutes':number(.1,1440,12),
        'timeModel':text('estimate-distance','preserve-scheduled','infer-road',default='estimate-distance'),'averageSpeedKph':number(1,300,22),
        'dwellMinutes':number(0,60,.35),'addedStopDwellMinutes':number(0,10,0),'segmentRuntimeMinutes':array(number(0)),'segmentDistancesKm':array(number(0))},['stops'])
    overlay_base = {'originStops','originWalkSeconds','destinationOffsets','destinationStops','destinationWalkSeconds','excludedTrips','departure','horizon','allowPreRideTransfers','allowPostRideTransfers','maximumBoardings'}
    overlay_properties = {k:v for k,v in schemas['TimetableOverlayManyQueryInput']['properties'].items() if k not in overlay_base}
    schemas['ReachOverlay'] = obj({**overlay_properties,'stops':array(ref('Point'),0,256)},['stops']+[k for k in schemas['TimetableOverlayManyQueryInput']['required'] if k not in overlay_base],strict=False)
    schemas['Scenario'] = obj({'id':text(),'name':text(),'cityRevision':text(),'services':array(service,0,128),'excludedTripIds':array(text()),'excludedRouteIds':array(text()),'overlay':ref('ReachOverlay')},description='Request-scoped. Use services or overlay. At most 256 unique planned points and one million planned stop events.')
    reach_common = {k:v for k,v in common.items() if k not in ['maxStreetKm','horizonMinutes','requireTransitRide','allowLongWalk']}
    reach_common['mode'] = text('transit','walk',default='transit')
    reach_common['timePreference'] = text('depart_at','depart',default='depart_at')
    schemas['ReachRequest'] = obj({**reach_common,'origin':ref('Point'),'cutoffsMinutes':{**array(number(1,240),1,16),'default':[15,30,45,60]},'rasterSize':number(16,1024,96,integer=True),
        'extentRadiusKm':number(1,40,8),'bounds':array(number(),4,4),'includeStreetEdges':boolean(),'includeNodes':boolean(),'scenario':ref('Scenario')},['origin'],allOf=[clock_rule,transit_date,mode_rule])
    schemas['CompareRequest'] = obj({'kind':text(),'id':{},'before':ref('ReachResult'),'after':ref('ReachResult')},['before','after'])
    cases = [obj({'operation':{'const':'timetable.identifiers'},'serviceDate':{'type':'string','format':'date'},'kind':text(),'id':{}},['operation','serviceDate'],strict=False)]
    for op,(request,response) in OPERATIONS.items():
        required=['operation','input'] + (['serviceDate'] if op.startswith('timetable.') else [])
        cases.append(obj({'operation':{'const':op},'input':ref(request),'serviceDate':{'type':'string','format':'date'},'kind':text(),'id':{},'allowStreetTransfers':boolean(True),'minimumTransferBufferMinutes':number(0,60,0,integer=True),'requireCompleteServiceCoverage':boolean()},required,strict=False))
    schemas['NativeRequest'] = {'oneOf':cases}
    schemas['Error'] = obj({'error':obj({'code':text(),'message':text()},['code','message'],strict=False),'id':{}},['error'],strict=False)
    schemas['QueryMetadata'] = obj({'schemaVersion':text(description='JSON interface version; not the executable version.'),'runtime':{'const':'rust'},'cityRevision':text(description='Revision of the City loaded by this process.'),'timing':obj({'totalMs':number(0,description='Milliseconds inside dispatch; excludes initial City loading, final serialization, HTTP queue/network time, and client parsing.')},['totalMs']),'id':{'description':'Echoed by Stream and dispatched HTTP queries, not by one-shot CLI.'}},strict=False)
    nullable_number = {'type':['number','null']}
    def nullable(schema): return {'anyOf':[schema,{'type':'null'}]}
    schemas['JourneyEndpoint'] = obj({'coordinate':ref('Coordinate'),'stopId':text(),'name':text()},['coordinate'],strict=False)
    schemas['RouteDisplay'] = obj({'shortName':nullable(text()),'longName':nullable(text()),'type':nullable(number(integer=True)),'color':nullable(text())},['shortName','longName','type','color'],strict=False)
    leg_times = {'departureMinutes':number(description='Service-day clock in minutes.'),'arrivalMinutes':number(description='Service-day clock in minutes.'),'durationMinutes':number(0,description='Elapsed minutes between the leg clocks.')}
    schemas['RouteLeg'] = obj({'kind':text('walk','ride','drive'),**leg_times,
        'departure':number(description='Native service-day clock in seconds, when present.'),'arrival':number(description='Native service-day clock in seconds, when present.'),
        'from':ref('JourneyEndpoint'),'to':ref('JourneyEndpoint'),'fromStopId':nullable(text()),'toStopId':nullable(text()),
        **{k:nullable(number(0,integer=True)) for k in ['fromStop','toStop','trip']},
        **{k:nullable(number()) for k in ['boardSequence','alightSequence']},
        'tripId':text(),'routeId':text(),'route':nullable(ref('RouteDisplay')),
        'stopIds':array(text()),'stopCount':number(0,integer=True,description='Stop-to-stop segments, not stopIds length.'),
        'coordinates':array(ref('Coordinate')),'distanceMeters':number(0),
        'geometrySource':text('gtfs_shape','stop_sequence','osm','station_selection','unverified_transfer'),
        'streetPathVerified':{'type':'boolean','description':'Present on materialized transit walking legs; absent on rides and direct street legs.'}},
        ['kind','departureMinutes','arrivalMinutes','durationMinutes'],strict=False,
        description='Transit leg or direct street leg. Presence depends on mode and geometry request; waiting appears as gaps between legs.')
    journey_fields = {**leg_times,'mode':text('transit','walk','drive'),'departure':number(),'arrival':number(),
        **{k:number(0) for k in ['walkingSeconds','rideSeconds','waitingSeconds','walkMinutes','rideMinutes','waitMinutes','distanceMeters']},
        'boardings':number(0,integer=True),'transfers':number(0,integer=True),'legs':array(ref('RouteLeg'))}
    schemas['Journey'] = obj(journey_fields,['departureMinutes','arrivalMinutes','durationMinutes'],strict=False,
        description='Materialized transit journey or compact direct walk in a transit matrix. No outer status or dispatch metadata; compact walks omit legs.')
    schemas['RouteResult'] = {'allOf':[ref('QueryMetadata'),obj({**journey_fields,'status':text('ready','blocked'),'reason':{},
        'serviceDate':text(),'dataMode':text('scheduled','realtime'),'warnings':{},
        'segments':array(ref('RouteResult')),'via':array(ref('Point')),'choices':array(ref('RouteResult')),
        'window':obj({'minutes':number(),'stepMinutes':number(),'searches':number(0,integer=True)},['minutes','stepMinutes','searches'],strict=False),
        'legIndex':number(0,integer=True),'leg':ref('RouteResult'),'diagnostics':{'type':'object'}},['status'],strict=False,
        description='Ready, blocked, via, or sampled-window route. Blocked results can omit all journey fields; via results use segments instead of legs.') ]}
    schemas['MatrixResult'] = {'allOf':[ref('QueryMetadata'),obj({'kind':{'const':'matrix'},'mode':text('transit','walk','drive'),'originCount':number(1,integer=True),'destinationCount':number(1,integer=True),
        'durationsMinutes':{**array(array(nullable_number)),'description':'Rows follow origins; columns follow destinations. Depart-at: arrival minus departure. Arrive-by transit: deadline minus latest departure, possibly longer than the actual journey.'},
        'distancesMeters':{**array(array(nullable_number)),'description':'Walk/Drive only; same row/column ordering.'},
        'journeys':nullable(array(array(nullable(ref('Journey'))))),'diagnostics':{'type':'object'},'warnings':{}},['kind','originCount','destinationCount','durationsMinutes'],strict=False)]}
    schemas['ReachStop'] = obj({'stopId':text(),'name':text(),'coordinate':ref('Coordinate'),'durationMinutes':number(0)},['stopId','name','coordinate','durationMinutes'],strict=False)
    schemas['StreetEdgeBundle'] = obj({'schemaVersion':{'const':'vigo.standalone.street-edges.v1'},'encoding':{'const':'indexed-json'},
        'count':number(0,integer=True),'nodeCount':number(0,integer=True),
        'nodes':{**array(number()),'description':'Flat longitude/latitude pairs, length 2 * nodeCount.'},
        'endpoints':{**array(number(0,integer=True)),'description':'From/to local node indices, length 2 * count.'},
        'edgeIds':array(number(0,integer=True)),
        'durationMinutes':{**array(number(0)),'description':'Elapsed time to each directed edge to-endpoint; not edge traversal time.'},
        'walkDistanceM':{**array(number(0)),'description':'Accumulated walking distance from the retained seed through the edge.'},
        'transitArrivalMinutes':{**array(number(-1)),'description':'Elapsed minutes at the transit seed; -1 means direct-origin seed.'}},
        ['schemaVersion','encoding','count','nodeCount','nodes','endpoints','edgeIds','durationMinutes','walkDistanceM','transitArrivalMinutes'],strict=False,
        description='All measurement arrays and edgeIds have count entries. Local node indices are bundle-specific.')
    schemas['ReachSurface'] = obj({'width':number(1,1024,integer=True),'height':number(1,1024,integer=True),'bounds':array(number(),4,4),
        'values':{**array(nullable_number),'description':'Elapsed minutes, northwest-first row-major. Null means no finite retained value; not a route to the cell center.'},
        'fullBounds':array(number(),4,4),'fullValues':array(nullable_number),'edges':nullable(ref('StreetEdgeBundle')),
        'nodes':{**array(ref('StreetSurfaceNode')),'description':'Separate object records, not edges.nodes. The current high-level wrapper returns at most one node when requested.'}},
        ['width','height','bounds','values'],strict=False,description='Full values use fullBounds and the same dimensions. Recomputed bounds may be smaller or larger than the requested view.')
    def collection(geometry, coordinates):
        feature=obj({'type':{'const':'Feature'},'properties':obj({'cutoffMinutes':number(0)},['cutoffMinutes'],strict=False),
            'geometry':obj({'type':{'const':geometry},'coordinates':coordinates},['type','coordinates'],strict=False)},['type','properties','geometry'],strict=False)
        return obj({'type':{'const':'FeatureCollection'},'features':array(feature)},['type','features'],strict=False)
    schemas['ReachAreas'] = collection('MultiPolygon',array(array(array(ref('Coordinate')))))
    schemas['ReachContours'] = collection('MultiLineString',array(array(ref('Coordinate'))))
    schemas['ReachResult'] = {'allOf':[ref('QueryMetadata'),obj({'kind':{'const':'reach'},'mode':text('transit','walk'),'origin':ref('Point'),'serviceDate':nullable(text()),
        'surface':ref('ReachSurface'),'cutoffsMinutes':array(number()),'stops':array(ref('ReachStop')),
        'areas':ref('ReachAreas'),'fullAreas':ref('ReachAreas'),'contours':ref('ReachContours'),'fullContours':ref('ReachContours'),
        'diagnostics':{'type':'object'},'warnings':{}},['surface','stops'],strict=False)]}
    schemas['CompareResult'] = {'allOf':[ref('QueryMetadata'),obj({'schemaVersion':{'const':'vigo.standalone.comparison.v1'},'commonCells':number(0,integer=True),'newlyReachableCells':number(0,integer=True),'noLongerReachableCells':number(0,integer=True),'meanChangeMinutes':nullable_number,'deltaMinutes':array(nullable_number),'sign':{'const':'after-minus-before'},'bounds':array(number(),4,4),'width':number(1,integer=True),'height':number(1,integer=True)},['deltaMinutes','commonCells','newlyReachableCells','noLongerReachableCells'],strict=False)]}
    schemas['NativeResult'] = {'allOf':[ref('QueryMetadata'),{'oneOf':[obj({'operation':{'const':op},'result':ref(response)},['operation','result'],strict=False) for op,(_,response) in OPERATIONS.items()]+[obj({'operation':{'const':'timetable.identifiers'},'result':obj({k:array(text()) for k in ['stopIds','tripIds','routeIds','accessMemberStopIds']},strict=False)},['operation','result'],strict=False)]}]}
    # Public projection is independent of the native witness schemas above.
    seconds = {'type':'integer','minimum':0}
    nullable_seconds = {'type':['integer','null'],'minimum':0}
    schemas['PublicIdentifier'] = obj({'feed':{'type':['string','null']},'id':text()},['feed','id'])
    schemas['PublicEndpoint'] = obj({'stop':ref('PublicIdentifier'),'name':text(),'coordinate':ref('Coordinate')},strict=False)
    schemas['PublicLeg'] = obj({'type':text('walk','transit','drive'),'from':ref('PublicEndpoint'),'to':ref('PublicEndpoint'),
        'departureTime':text(),'arrivalTime':text(),'durationSeconds':seconds,'distanceMeters':seconds,'quality':{'type':'object'},
        'geometry':obj({'type':{'const':'LineString'},'coordinates':array(ref('Coordinate'))},['type','coordinates'])},
        ['type','from','to','departureTime','arrivalTime','durationSeconds','quality'],strict=False)
    schemas['PublicJourney'] = obj({'departureTime':text(),'arrivalTime':text(),'durationSeconds':seconds,
        **{k:nullable_seconds for k in ['walkingSeconds','waitingSeconds','ridingSeconds','drivingSeconds']},
        'boardings':seconds,'transfers':seconds,'legs':array(ref('PublicLeg'))},
        ['departureTime','arrivalTime','durationSeconds','walkingSeconds','waitingSeconds','ridingSeconds','boardings','transfers','legs'],strict=False)
    public_common = {'schema':text(),'status':text('ok','not_found'),'mode':text('transit','walk','drive'),
        'query':{'type':'object'},'meta':obj({'engineVersion':text(),'cityRevision':{'type':['string','null']},'requestId':{},
            'queryFingerprint':text(),'computeUs':nullable_seconds,'computeScope':text()},
            ['engineVersion','cityRevision','requestId','queryFingerprint','computeUs','computeScope'],strict=False),
        'diagnostics':{'type':'object'},'profile':{'type':'object'},'trace':{'type':'object'},'warnings':array({'type':'object'}),'datasetLimitations':{},'id':{}}
    schemas['RouteResult'] = obj({**public_common,'schema':{'const':'vigo.route.v1'},'journey':nullable(ref('PublicJourney')),'reason':{'type':'object'},'alternatives':array(nullable(ref('PublicJourney')))},['schema','status','query','meta','journey'],strict=False)
    schemas['MatrixResult'] = obj({**public_common,'schema':{'const':'vigo.matrix.v1'},'durationsSeconds':array(array(nullable_seconds)),'journeys':array(array(nullable(ref('PublicJourney'))))},['schema','status','query','meta','durationsSeconds'],strict=False)
    public_surface = obj({'width':seconds,'height':seconds,'bounds':array(number(),4,4),'valuesSeconds':array(nullable_seconds)},['width','height','bounds','valuesSeconds'],strict=False)
    schemas['ReachResult'] = obj({**public_common,'schema':{'const':'vigo.reach.v1'},'surface':public_surface,'fullSurface':public_surface,'cutoffsSeconds':array(seconds),
        **{k:{'type':'object'} for k in ['areas','contours','fullAreas','fullContours']}},['schema','status','query','meta','surface','cutoffsSeconds'],strict=False)
    schemas['CompareRequest'] = obj({'before':{'oneOf':[ref(k+'Result') for k in ['Route','Matrix','Reach']]},'after':{'oneOf':[ref(k+'Result') for k in ['Route','Matrix','Reach']]}},['before','after'],strict=False)
    schemas['CompareResult'] = obj({'schema':{'const':'vigo.compare.v1'},'status':{'const':'ok'},'durationChangeSeconds':{'type':['integer','null']},'meanChangeSeconds':{'type':['number','null']},'counts':{'type':'object'}},['schema','status'],strict=False)
    paths = {}
    def response(schema, description='Successful response'):
        return {'description':description,'content':{'application/json':{'schema':ref(schema)}}}
    for kind in ['route','matrix','reach','compare','native']:
        title=kind.title()
        paths['/v1/'+kind]={'post':{'operationId':kind,'summary':title,'parameters':[{'in':'query','name':'diagnostics','schema':text('none','summary','profile','trace'),'description':'Optional diagnostic detail; default none.'},{'in':'query','name':'includeGeometry','schema':{'type':'boolean'}},{'in':'query','name':'includeLimitations','schema':{'type':'boolean'}}],'requestBody':{'required':True,'content':{'application/json':{'schema':ref(title+'Request')}}},'responses':{'200':response(title+'Result'),'400':response('Error','Invalid request'),'401':response('Error','Bearer authentication failed'),'408':response('Error','Request read deadline'),'413':response('Error','Body limit'),'417':response('Error','Unsupported Expect header'),'431':response('Error','Header limit'),'503':response('Error','Capacity or worker unavailable'),'504':response('Error','Query deadline or worker failed')}}}
    paths['/v1/isochrone']={'post':{**paths['/v1/reach']['post'],'operationId':'isochrone','summary':'Alias of Reach'}}
    for kind in ['info','capabilities']:
        paths['/v1/'+kind]={'get':{'operationId':kind,'summary':kind.title(),'responses':{'200':{'description':'Runtime metadata; inspect capabilities for supported combinations.','content':{'application/json':{'schema':{'type':'object'}}}},'401':response('Error','Bearer authentication failed')}}}
    for name in ['healthz','readyz']:
        paths['/'+name]={'get':{'operationId':name,'security':[],'summary':'Liveness' if name=='healthz' else 'Readiness','responses':{'200':{'description':'Ready, or live while recovering','content':{'application/json':{'schema':obj({'status':text('ready','recovering'),'runtime':{'const':'rust'},'version':text()},['status','runtime','version'])}}},**({'503':{'description':'Worker recovering'}} if name=='readyz' else {})}}}
    for name in ['/','/docs','/docs/']:
        paths[name]={'get':{'security':[],'summary':'Offline manual','responses':{'200':{'description':'Self-contained HTML','content':{'text/html':{'schema':{'type':'string'}}}}}}}
    for name in ['/openapi.json','/docs/openapi.json','/standalone-openapi.json','/docs/standalone-openapi.json']:
        paths[name]={'get':{'security':[],'summary':'This OpenAPI document','responses':{'200':{'description':'OpenAPI 3.1 JSON','content':{'application/json':{'schema':{'type':'object'}}}}}}}
    return {'openapi':'3.1.0','info':{'title':'VIGO Rust standalone API','version':VERSION+'-development','description':'Prepared City routing and isochrones. Public result schemas are shared with the Node CLI; raw native and trace contracts are separate. Runtime validates mode combinations and native index/array invariants beyond these structural schemas. Bearer auth is optional only when no token is configured on a loopback listener.'},
        'servers':[{'url':'http://127.0.0.1:8080','description':'Default localhost listener'},{'url':'http://127.0.0.1:8787','description':'Optional synthetic local demo'}],
        'security':[{'bearerAuth':[]}],'paths':paths,'components':{'securitySchemes':{'bearerAuth':{'type':'http','scheme':'bearer'}},'schemas':schemas}}


def slug(title):
    return re.sub(r'[^\w\-\s]', '', re.sub(r'<[^>]*>', '',title.lower())).replace(' ','-')


def inline(source):
    tokens=[]
    def keep(value):
        tokens.append(value); return f'\x00{len(tokens)-1}\x00'
    def code(match):
        value=html.escape(match[1])
        if re.fullmatch(r'[A-Za-z][A-Za-z0-9_.<>,]*',match[1]):
            pieces=re.split(r'(?<=[a-z0-9])(?=[A-Z])|(?<=[._<>,])',match[1])
            value='<wbr>'.join(html.escape(piece) for piece in pieces)
        return keep('<code>'+value+'</code>')
    source=re.sub(r'`([^`]+)`',code,source)
    source=html.escape(source)
    source=re.sub(r'\[([^\]]+)\]\(([^)]+)\)',lambda m:'<a href="'+m[2]+'">'+m[1]+'</a>',source)
    source=re.sub(r'\*\*([^*]+)\*\*',r'<strong>\1</strong>',source)
    return re.sub(r'\x00(\d+)\x00',lambda m:tokens[int(m[1])],source)


def code_block(source, language):
    if language in ('json', 'ndjson'):
        pieces=[]; offset=0
        for match in re.finditer(r'"(?:\\.|[^"\\])*"|(?<![\w.])-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|\b(?:true|false|null)\b',source):
            pieces.append(html.escape(source[offset:match.start()]))
            token=match[0]
            kind='key' if token.startswith('"') and re.match(r'\s*:',source[match.end():]) else 'string' if token.startswith('"') else 'literal'
            pieces.append(f'<span class="syntax-{kind}">{html.escape(token)}</span>')
            offset=match.end()
        pieces.append(html.escape(source[offset:])); body=''.join(pieces)
    else: body=html.escape(source)
    return '<div class="code-block"><button class="copy" type="button" aria-label="Copy code">Copy</button><pre tabindex="0"><code>'+body+'</code></pre></div>'


def markdown(source, used=None, page_key=''):
    used=used if used is not None else {}
    lines=source.splitlines(); output=[]; i=0
    while i<len(lines):
        line=lines[i]
        if not line.strip() or line.startswith('<!--'): i+=1; continue
        if line.startswith('```'):
            platform=re.match(r'^```(\w+) platform=(unix|windows)$',line)
            if platform:
                alternatives=[]
                while i<len(lines):
                    match=re.match(r'^```(\w+) platform=(unix|windows)$',lines[i])
                    if not match: break
                    body=[]; i+=1
                    while i<len(lines) and not lines[i].startswith('```'): body.append(lines[i]); i+=1
                    alternatives.append((match[2],match[1],'\n'.join(body))); i+=1
                    while i<len(lines) and not lines[i].strip(): i+=1
                number=used.get('_platform_groups',0)+1; used['_platform_groups']=number
                prefix=f'platform-{number}'; buttons=[]; panels=[]
                for n,(system,language,body) in enumerate(alternatives):
                    label='macOS / Linux' if system=='unix' else 'Windows'
                    identifier=f'{prefix}-{system}'
                    buttons.append(f'<button type="button" role="tab" id="{identifier}" aria-controls="{identifier}-panel" aria-selected="{str(n==0).lower()}" tabindex="{0 if n==0 else -1}">{label}</button>')
                    panels.append(f'<div role="tabpanel" id="{identifier}-panel" aria-labelledby="{identifier}"'+(' hidden' if n else '')+'>'+code_block(body,language)+'</div>')
                output.append('<div class="platform-group"><div class="platform-tabs" role="tablist" aria-label="Operating system">'+''.join(buttons)+'</div>'+''.join(panels)+'</div>')
                continue
            lang=line[3:].split(' ')[0]; body=[]; i+=1
            while i<len(lines) and not lines[i].startswith('```'): body.append(lines[i]); i+=1
            output.append(code_block('\n'.join(body),lang)); i+=1; continue
        heading=re.match(r'^(#{1,6})\s+(.+)$',line)
        if heading:
            level=len(heading[1]); title=heading[2]; identifier=slug(title)
            n=used.get(identifier,0); used[identifier]=n+1
            if n: identifier+='-'+str(n)
            output.append(f'<h{level} id="{identifier}">{inline(title)}</h{level}>'); i+=1; continue
        if line.startswith('|'):
            rows=[]
            while i<len(lines) and lines[i].startswith('|'):
                cells=re.split(r'(?<!\\)\|',lines[i].strip().strip('|'))
                if not all(re.fullmatch(r'\s*:?-+:?\s*',c) for c in cells): rows.append([inline(c.strip().replace('\\|','|')) for c in cells])
                i+=1
            table_class=''
            if rows[0][:2] == ['JSON field', 'Rust / JSON type'] and rows[0][-1] == 'Meaning':
                # Keep each description with its field and omit empty notes.
                # The Markdown dictionary retains the original four columns.
                rows=[['JSON field', 'Rust type', rows[0][2]]]+[
                    [field+('<p class="field-description">'+description+'</p>' if description!='—' else ''),typ,required]
                    for field,typ,required,description in rows[1:]
                ]
                table_class=' class="field-table"'
            head=''.join('<th scope="col">'+c+'</th>' for c in rows[0])
            body=[]
            for row in rows[1:]:
                code=re.search(r'<code>(.*?)</code>',row[0])
                attributes=''
                if code and page_key:
                    label=html.unescape(re.sub(r'<[^>]+>','',code[1]))
                    identifier=page_key+'--'+slug(label)
                    n=used.get(identifier,0); used[identifier]=n+1
                    if n: identifier+='-'+str(n)
                    attributes=f' id="{identifier}" data-search-label="{html.escape(label,quote=True)}" tabindex="-1"'
                cells=''.join('<td data-column="'+html.escape(rows[0][n],quote=True)+'">'+cell+'</td>' for n,cell in enumerate(row))
                body.append('<tr'+attributes+'>'+cells+'</tr>')
            body=''.join(body)
            output.append('<div class="table-wrap"><table'+table_class+'><thead><tr>'+head+'</tr></thead><tbody>'+body+'</tbody></table></div>'); continue
        if line.startswith('- '):
            items=[]
            while i<len(lines) and lines[i].startswith('- '): items.append('<li>'+inline(lines[i][2:])+'</li>'); i+=1
            output.append('<ul>'+''.join(items)+'</ul>'); continue
        paragraph=[line]; i+=1
        while i<len(lines) and lines[i].strip() and not re.match(r'^(#|```|\||- |<!--)',lines[i]): paragraph.append(lines[i]); i+=1
        output.append('<p>'+inline(' '.join(paragraph))+'</p>')
    return '\n'.join(output)


PAGE_NAMES = [
    ('quickstart', 'Quickstart'), ('installation', 'Installation'), ('city-data', 'City data'),
    ('cli', 'Command line'), ('points-and-time', 'Points, time, and units'), ('route', 'Route'),
    ('via-and-windows', 'Via points and departure windows'), ('matrix', 'Matrix'),
    ('reach', 'Reach and isochrones'), ('scenarios', 'Scenarios'), ('compare', 'Compare results'),
    ('realtime', 'Realtime and traffic'), ('results', 'Results and errors'), ('streaming', 'Streaming'),
    ('http-api', 'HTTP API'), ('deployment', 'Deployment'), ('clients', 'Client integration'),
    ('native-api', 'Native API'), ('troubleshooting', 'Troubleshooting'), ('validation', 'Compatibility'),
]
OUTPUT_PAGES = [
    ('route-output', 'Route output'), ('matrix-output', 'Matrix output'),
    ('reach-output', 'Reach output'), ('comparison-output', 'Comparison output'),
    ('diagnostics-output', 'Diagnostics and native output'),
]
PAGE_GROUPS = [
    ('Getting started', ['overview', 'quickstart', 'installation', 'city-data']),
    ('Routing', ['route', 'via-and-windows', 'matrix', 'reach', 'scenarios', 'compare', 'realtime']),
    ('Results', ['results']+[key for key,_ in OUTPUT_PAGES]),
    ('Reference', ['cli', 'points-and-time', 'streaming', 'http-api', 'clients', 'native-api', 'native-fields']),
    ('Operations', ['deployment', 'troubleshooting', 'walking-evidence', 'validation', 'audit-record']),
]


def page(source,native,audit,walking):
    source=source.replace('../standalone.html','#overview').replace('../standalone-openapi.json','standalone-openapi.json').replace('../reference/rust-standalone-audit.md','#audit-record').replace('../reference/rust-standalone-native.md','#native-fields')
    source=source.replace('../reference/walking-evidence.md','#walking-evidence')
    _,*parts=re.split(r'(?=^## \d+\. )',source,flags=re.M)
    assert len(parts)==len(PAGE_NAMES), 'Give every manual chapter a page and navigation label'
    pages={}
    overview=f'''VIGO runs transit, walking, and driving queries from a standalone Rust executable. Use the command line for individual jobs or serve a prepared City over HTTP.

## Start with Boston

Follow the [Boston quickstart](#quickstart) to route from Harvard Square to South Station. The [data instructions](#city-data) show where to download the MBTA timetable and OpenStreetMap streets, and how to compile them into `boston/`. Then start a local service:

```sh
./vigo serve --city ./boston --port 8080
```

Open `http://127.0.0.1:8080/` for this manual. The [quickstart](#quickstart) walks through a request and its response.

## Guides and reference

- **[Route](#route)** Find a journey by transit, walking, or driving. Set a departure time or an arrival deadline.
- **[Matrix](#matrix)** Calculate travel times for many origin–destination pairs in one request.
- **[Reach and isochrones](#reach)** Find streets and areas reachable by transit or walking within a time limit.
- **[Scenarios](#scenarios)** Measure service changes with temporary exclusions, schedules, and overlays in Reach.
- **[HTTP API](#http-api)** Connect an application using JSON requests. Look up endpoints, limits, and status codes.
- **[Deployment](#deployment)** Configure authentication, containers, and process supervision for your own server.

## Runtime and data

The executable includes the routing kernels, HTTP server, and SQLite. Network preparation uses the separate VIGO compiler. Once a City is prepared, queries need no Node, Python, or internet connection.

This manual covers VIGO {VERSION}. See [Compatibility](#validation) for supported operations, interface differences, and build information.
'''
    pages['overview']={'title':'Routing and isochrones','label':'Overview','body':overview,'legacy':'vigo-rust-standalone-manual'}
    for (key,title),part in zip(PAGE_NAMES,parts):
        heading,body=part.split('\n',1)
        if key=='results':
            body,*details=re.split(r'(?=^### (?:'+ '|'.join(re.escape(title) for _,title in OUTPUT_PAGES)+r')$)',body,flags=re.M)
            assert len(details)==len(OUTPUT_PAGES), 'Keep each output reference on its own page'
            for (output_key,output_title),detail in zip(OUTPUT_PAGES,details):
                detail_heading,detail_body=detail.split('\n',1)
                assert detail_heading=='### '+output_title
                detail_body=re.sub(r'^(#{4,6}) ',lambda m:m[1][2:]+' ',detail_body,flags=re.M)
                pages[output_key]={'title':output_title,'label':output_title,'body':detail_body}
                if slug(output_title)!=output_key: pages[output_key]['legacy']=slug(output_title)
        body=re.sub(r'^(#{3,6}) ',lambda m:m[1][1:]+' ',body,flags=re.M)
        pages[key]={'title':title,'label':title,'body':body,'legacy':slug(heading[3:])}
    native=native.replace('../guides/rust-standalone.md#18-native-operation-reference','#native-api')
    index,*types=re.split(r'(?=^## )',native,flags=re.M)
    # Type definitions have their own pages; the operation table is the index.
    index=re.sub(r'^# [^\n]+\n+Generated[^\n]+\n+', '', index)
    pages['native-fields']={'title':'Native fields','label':'Native fields','body':index}
    for part in types:
        heading,body=part.split('\n',1)
        title=heading[3:]
        pages[slug(title)]={'title':title,'label':title,'body':body,'parent':'native-fields'}
    pages['audit-record']={'title':'Test record','label':'Test record','body':audit.split('\n',1)[1]}
    walking=walking.replace('../guides/quickstart.md','#city-data').replace('../guides/rust-standalone.md','#city-data')
    pages['walking-evidence']={'title':'Walking evidence','label':'Walking evidence','body':walking.split('\n',1)[1]}
    order=[key for _,keys in PAGE_GROUPS for key in keys]
    type_order=[slug(part.splitlines()[0][3:]) for part in types]
    used={key:1 for key in pages}
    used.update({p['legacy']:1 for p in pages.values() if p.get('legacy')})
    nav=[]
    for group,keys in PAGE_GROUPS:
        links=''.join(f'<a href="#{key}" data-nav="{key}">{html.escape(pages[key]["label"])}</a>' for key in keys)
        nav.append(f'<section class="nav-group"><h2>{group}</h2>{links}</section>')
    articles=[]
    def page_title(p, field='title'):
        title=html.escape(p[field])
        return re.sub(r'(?<=[a-z])(?=[A-Z])','<wbr>',title) if p.get('parent') else title
    for key,p in pages.items():
        sequence=type_order if p.get('parent') else order
        position=sequence.index(key)
        pagination=[]
        for offset,label in [(-1,'Previous'),(1,'Next')]:
            neighbor=position+offset
            if 0<=neighbor<len(sequence):
                target=sequence[neighbor]
                pagination.append(f'<a class="{label.lower()}" href="#{target}" rel="{("prev" if offset==-1 else "next")}"><span>{label}</span>{page_title(pages[target],"label")}</a>')
        legacy=f'<span class="anchor" id="{p["legacy"]}"></span>' if p.get('legacy') else ''
        breadcrumb='<p class="breadcrumb"><a href="#native-fields">Native fields</a></p>' if p.get('parent') else ''
        hidden='' if key=='overview' else ' hidden'
        body=markdown(p['body'],used,key)
        if key=='overview': body=body.replace('<ul>','<ul class="topic-index">',1)
        headings=re.findall(r'<h2 id="([^"]+)">(.+?)</h2>',body)
        outline='<aside class="page-outline" aria-label="On this page"><p>On this page</p><nav>'+''.join(f'<a href="#{identifier}">{title}</a>' for identifier,title in headings)+'</nav></aside>' if len(headings)>1 else ''
        articles.append(f'<article class="doc-page" id="page-{key}" data-page="{key}" data-title="{html.escape(p["title"],quote=True)}" data-nav="{p.get("parent",key)}"{hidden}>{legacy}{breadcrumb}<h1 id="{key}" tabindex="-1">{page_title(p)}</h1>{outline}<div class="page-body">{body}</div><nav class="pagination" aria-label="Page navigation">{"".join(pagination)}</nav></article>')
    css=(ROOT/'scripts/standalone-docs.css').read_text(encoding='utf-8')
    javascript=(ROOT/'scripts/standalone-docs.js').read_text(encoding='utf-8')
    logo=base64.b64encode((ROOT/'public/vigo-wordmark.png').read_bytes()).decode()
    return f'''<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light"><meta name="description" content="VIGO documentation: routing, matrices, isochrones, and deployment."><title>Documentation — VIGO</title><style>{css}</style></head>
<body><a class="skip" href="#content">Skip to content</a><header class="site-header"><a class="brand" href="#overview" aria-label="VIGO documentation"><img src="data:image/png;base64,{logo}" alt="VIGO" width="148" height="28"></a><span class="site-title">Documentation</span><div class="header-actions"><a href="standalone-openapi.json" download>API schema</a><button id="print" type="button">Print page</button></div></header>
<details class="sidebar" id="navigation" open><summary>Contents</summary><div class="sidebar-body"><div class="search-box"><label class="sr-only" for="search">Search documentation</label><input id="search" type="search" placeholder="Search documentation" autocomplete="off" aria-controls="search-results"></div><div id="search-results" hidden><p id="search-status" role="status"></p><div id="search-links"></div></div><nav id="chapters" aria-label="Documentation">{''.join(nav)}</nav></div></details>
<main id="content" tabindex="-1">{''.join(articles)}</main><span id="copy-status" class="sr-only" role="status"></span><noscript><style>.doc-page[hidden],.platform-group [role="tabpanel"][hidden]{{display:block!important}}.pagination,.platform-tabs,.page-outline{{display:none}}</style></noscript><script>{javascript}</script></body></html>\n'''


def main():
    parser=argparse.ArgumentParser(description=__doc__); parser.add_argument('--check',action='store_true'); args=parser.parse_args()
    source=SOURCE.read_text(encoding='utf-8'); native,native_md=native_contracts()
    public_results=(ROOT/'docs/reference/results.md').read_text(encoding='utf-8')
    source=source.replace('<!-- PUBLIC_RESULTS -->', '\n'.join('##'+line if line.startswith('#') else line for line in public_results.splitlines()[1:]))
    audit=(ROOT/'docs/reference/rust-standalone-audit.md').read_text(encoding='utf-8')
    walking=(ROOT/'docs/reference/walking-evidence.md').read_text(encoding='utf-8')
    products={'docs/reference/rust-standalone-native.md':native_md,'docs/standalone-openapi.json':json.dumps(specification(native),indent=2,ensure_ascii=False)+'\n','docs/standalone.html':page(source,native_md,audit,walking)}
    for name,body in products.items():
        path=ROOT/name
        if args.check:
            assert path.exists() and path.read_text(encoding='utf-8')==body, f'{name} is stale; run npm run docs:standalone'
        else: path.write_text(body, encoding='utf-8')
    print(json.dumps({'status':'current' if args.check else 'generated','files':list(products),'nativeOperations':len(OPERATIONS)+1,'nativeTypes':len(native)}))


if __name__=='__main__': main()
