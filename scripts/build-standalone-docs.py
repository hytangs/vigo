#!/usr/bin/env python3
"""Generate the engine OpenAPI document, the public API schema reference and the native field reference using only the standard library."""
import argparse
import json
from pathlib import Path
import re
import sys

ROOT = Path(__file__).resolve().parent.parent
sys.dont_write_bytecode = True
SOURCE = ROOT / 'docs/guides/rust-standalone.md'
VERSION = json.loads((ROOT / 'package.json').read_text(encoding='utf-8'))['version']
OPERATIONS = {
    'places.describe': ('DescribePlacesInput', 'DescribePlacesResult'),
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
    ('StreetSurfaceResult', 'edge_evidence_durations'): 'Elapsed minutes at each retained directed interval end, not its traversal duration.',
    ('StreetSurfaceResult', 'edge_evidence_transit_arrivals'): 'Elapsed seed duration for each indexed edge; -1 marks seed index zero.',
    ('StreetSurfaceResult', 'node_evidence_truncated'): 'True when reached-node samples exceeded nodeEvidenceLimit after clamping.',
}


def native_contracts():
    structs = {}
    sources = list((ROOT / 'crates/vigo-runtime/src').rglob('*.rs'))
    for crate in ('vigo-route', 'vigo-format', 'vigo-prepare'):
        sources.extend((ROOT / 'crates' / crate / 'src').rglob('*.rs'))
    for path in sorted(sources):
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
        aliases = {'F64Buffer': 'f64', 'U32Buffer': 'u32', 'U8Buffer': 'u8', 'Float64Array': 'f64', 'Uint32Array': 'u32', 'Uint8Array': 'u8', 'Int32Array': 'i32', 'Uint16Array': 'u16', 'Float32Array': 'f32'}
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
             'Native operations are diagnostic tools outside the public stability policy. See [native operations](../guides/rust-standalone.md#native-operations) for units, index domains and examples. In requests, an optional field accepts omission or null. Result objects include every listed field; an unavailable optional value is null. Native arrays become JSON arrays, and non-finite result numbers become null. The runtime also checks compatible array lengths, indices, and values.', '',
             '| Operation | Input | Result |', '| --- | --- | --- |', '| `timetable.identifiers` | No input object | Active identifier arrays |', '| `timetable.prepare` | Service date and query settings; no input object | Ready state and preparation timing; no search |', '| `street.prepare`, `bike.prepare`, `drive.prepare` | No input object | Ready state; loads the mode without routing |']
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
    # Public requests/results have one owning model. Add only diagnostic
    # operation shapes, which are generated from the kernel's Rust structs.
    model = json.loads((ROOT / 'crates/vigo-model/generated/openapi.json').read_text(encoding='utf-8'))
    assert model['info']['version'] == VERSION, 'Regenerate vigo-model for the current version'
    schemas = model['components']['schemas']
    assert not (set(native) & set(schemas)), 'Native/public schema names must not collide'
    schemas.update(native)
    cases = [obj({'operation':{'const':'timetable.identifiers'},'serviceDate':{'type':'string','format':'date'},'kind':text(),'id':{}},['operation','serviceDate'],strict=False)]
    cases.append(obj({'operation':{'const':'timetable.prepare'},'serviceDate':{'type':'string','format':'date'},'time':text(),'timeMinutes':number(0),'timePreference':text('depart_at','arrive_by'),'allowStreetTransfers':boolean(True),'minimumTransferBufferMinutes':number(0,60,0,integer=True),'kind':text(),'id':{}},['operation','serviceDate'],strict=False))
    for op in ['street.prepare', 'bike.prepare', 'drive.prepare']:
        cases.append(obj({'operation': {'const': op}, 'kind': text(), 'id': {}}, ['operation'], strict=False))
    for op,(request,response) in OPERATIONS.items():
        required=['operation','input'] + (['serviceDate'] if op.startswith('timetable.') else [])
        cases.append(obj({'operation':{'const':op},'input':ref(request),'serviceDate':{'type':'string','format':'date'},'kind':text(),'id':{},'allowStreetTransfers':boolean(True),'minimumTransferBufferMinutes':number(0,60,0,integer=True),'requireCompleteServiceCoverage':boolean()},required,strict=False))
    schemas['NativeRequest'] = {'oneOf':cases}
    schemas['QueryMetadata'] = obj({'schemaVersion':text(description='JSON interface version; not the executable version.'),'runtime':{'const':'rust'},'cityRevision':text(description='Revision of the City loaded by this process.'),'timing':obj({'totalMs':number(0,description='Milliseconds inside dispatch; excludes initial City loading, final serialization, HTTP queue/network time, and client parsing.')},['totalMs']),'id':{'description':'Echoed by Stream and dispatched HTTP queries, not by one-shot CLI.'}},strict=False)
    schemas['TimetablePreparation'] = obj({'ready':boolean(),'activationMs':number(0),'preparation':{}},['ready','activationMs','preparation'],strict=False)
    schemas['NativeResult'] = {'allOf':[ref('QueryMetadata'),{'oneOf':[obj({'operation':{'const':op},'result':ref(response)},['operation','result'],strict=False) for op,(_,response) in OPERATIONS.items()]+[obj({'operation':{'const':'timetable.prepare'},'result':ref('TimetablePreparation')},['operation','result'],strict=False),obj({'operation':{'const':'timetable.identifiers'},'result':obj({k:array(text()) for k in ['stopIds','tripIds','routeIds','accessMemberStopIds']},strict=False)},['operation','result'],strict=False)]}]}
    for op in ['street.prepare', 'bike.prepare', 'drive.prepare']:
        schemas['NativeResult']['allOf'][1]['oneOf'].append(obj({'operation': {'const': op}, 'result': obj({'ready': boolean()}, ['ready'])}, ['operation', 'result'], strict=False))
    operation = model['paths']['/v1/native']['post']
    operation['requestBody']['content']['application/json']['schema'] = ref('NativeRequest')
    operation['responses']['200']['content']['application/json']['schema'] = ref('NativeResult')
    # Runtime status endpoints use diagnostic JSON, not a public result family.
    for kind in ['traffic', 'realtime']:
        model['paths']['/v1/' + kind] = {'get': {
            'operationId': kind, 'summary': kind.title(),
            'responses': {'200': {'description': 'Runtime metadata.',
                'content': {'application/json': {'schema': {'type': 'object'}}}},
                **{code: model['paths']['/v1/info']['get']['responses'][code]
                   for code in ['401', '403']}}}}
    return model



PUBLIC_GROUPS = [
    ('Request schemas', 'Request bodies for `POST /v1/route`, `/v1/matrix`, `/v1/reach` (and `/v1/isochrone`) and `/v1/compare`, the same objects the command line and the resident stream accept, and the types they use.',
     ['RouteRequest', 'MatrixRequest', 'ReachRequest', 'CompareRequest']),
    ('Result schemas', 'Documents the engine writes for a query, keyed by their `schema` field, and the types they use. A required field is always present, although its value can be `null`.',
     ['Response', 'RouteResult', 'MatrixResult', 'ReachResult', 'CompareResult', 'DistributionResult', 'ErrorResult', 'StreamDetail']),
    ('Service schemas', '`GET /v1/capabilities` and `GET /v1/info`.', ['Capabilities', 'InfoResult', 'CollectionInfoResult']),
]


def _cell(text):
    return ' '.join(str(text).split()).replace('|', '\\|')


def _ref_name(value):
    return value['$ref'].rsplit('/', 1)[-1]


def _type(schema):
    """A compact, linked Markdown description of a JSON Schema type."""
    if schema is True or schema == {}:
        return 'any'
    if not isinstance(schema, dict):
        return 'any'
    if '$ref' in schema:
        name = _ref_name(schema)
        return f'[{name}](#{name.lower()})'
    for key in ('oneOf', 'anyOf'):
        if key in schema:
            parts = []
            for option in schema[key]:
                rendered = _type(option)
                if rendered not in parts:
                    parts.append(rendered)
            return ' or '.join(parts)
    if 'const' in schema:
        return f'`{json.dumps(schema["const"])}`'
    if 'enum' in schema:
        return ', '.join(f'`{json.dumps(value)}`' for value in schema['enum'])
    kind = schema.get('type')
    if isinstance(kind, list):
        names = [k for k in kind if k != 'null']
        rendered = ' or '.join(names) or 'null'
        return rendered + (' or null' if 'null' in kind else '')
    if kind == 'array':
        return f'array of {_type(schema.get("items", {}))}'
    if kind == 'object' and 'properties' not in schema:
        return 'object'
    if kind == 'object':
        return 'object with ' + ', '.join(f'`{name}`' for name in schema['properties'])
    return kind or 'any'


def _limits(schema):
    if not isinstance(schema, dict):
        return ''
    notes = []
    low, high = schema.get('minimum'), schema.get('maximum')
    if low is not None and high is not None:
        notes.append(f'{low}–{high}')
    elif low is not None:
        notes.append(f'≥ {low}')
    elif high is not None:
        notes.append(f'≤ {high}')
    few, many = schema.get('minItems'), schema.get('maxItems')
    if few is not None and many is not None:
        notes.append(f'{few}–{many} items')
    elif many is not None:
        notes.append(f'≤ {many} items')
    elif few:
        notes.append(f'≥ {few} items')
    if schema.get('format') in ('date', 'date-time'):
        notes.append(schema['format'])
    return ', '.join(notes)


def _references(schema, found):
    if isinstance(schema, dict):
        if '$ref' in schema:
            name = _ref_name(schema)
            if name not in found:
                found.append(name)
        for value in schema.values():
            _references(value, found)
    elif isinstance(schema, list):
        for value in schema:
            _references(value, found)


def public_schema_reference(model):
    """Markdown tables for every public schema, generated from vigo-model."""
    schemas = model['components']['schemas']
    assigned = {}
    order = []
    for title, _, roots in PUBLIC_GROUPS:
        queue = list(roots)
        while queue:
            name = queue.pop(0)
            if name in assigned:
                continue
            assigned[name] = title
            order.append(name)
            found = []
            _references(schemas[name], found)
            queue.extend(found)
    rest = sorted(name for name in schemas if name not in assigned)
    groups = [(title, intro, [n for n in order if assigned[n] == title]) for title, intro, _ in PUBLIC_GROUPS]
    if rest:
        groups.append(('Other schemas', 'Types not reachable from the documents above.', rest))
    lines = ['# API schema', '',
             f'Generated for VIGO {VERSION} from `crates/vigo-model`, the types that read every public request and write every public Result. Regenerate with `npm run docs:standalone`; the documentation check fails when this page is stale.', '',
             'Use it to look up a field. The [engine reference](../guides/rust-standalone.md) explains how requests behave, and [public results](results.md) explains how to read answers. The same definitions are in the [OpenAPI document](../standalone-openapi.json). The engine also validates what a schema cannot express, such as combinations of fields, and accepts a few fields the typed model does not list yet; the engine reference documents every accepted field.', '',
             '| Endpoint | Request | Response |', '| --- | --- | --- |']
    for path, operations in model['paths'].items():
        for method, operation in operations.items():
            request = operation.get('requestBody', {}).get('content', {}).get('application/json', {}).get('schema')
            response = operation.get('responses', {}).get('200', {}).get('content', {}).get('application/json', {}).get('schema')
            if not (request and '$ref' in json.dumps(request)) and not (response and '$ref' in json.dumps(response)):
                continue
            lines.append(f'| `{method.upper()} {path}` | {_cell(_type(request)) if request else "—"} | {_cell(_type(response)) if response else "—"} |')
    for title, intro, names in groups:
        lines += ['', f'## {title}', '', intro]
        for name in names:
            schema = schemas[name]
            lines += ['', f'### {name}', '']
            if schema.get('description'):
                lines += [' '.join(schema['description'].split()), '']
            properties = schema.get('properties')
            if properties:
                required = set(schema.get('required', []))
                lines += ['| Field | Type | Required | Default | Notes |', '| --- | --- | --- | --- | --- |']
                for field, value in properties.items():
                    value = value if isinstance(value, dict) else {}
                    default = f'`{json.dumps(value["default"])}`' if 'default' in value else ''
                    notes = '. '.join(part for part in [_limits(value), ' '.join((value.get('description') or '').split())] if part)
                    lines.append(f'| `{field}` | {_cell(_type(value))} | {"Yes" if field in required else ""} | {_cell(default)} | {_cell(notes)} |')
            else:
                values = schema.get('oneOf') or schema.get('anyOf')
                described = [v for v in values or [] if isinstance(v, dict) and v.get('description') and ('const' in v or 'enum' in v)]
                if described:
                    lines += ['| Value | Meaning |', '| --- | --- |']
                    for option in values:
                        meaning = ' '.join((option.get('description') or '').split()) if isinstance(option, dict) else ''
                        lines.append(f'| {_cell(_type(option))} | {_cell(meaning)} |')
                else:
                    limits = _limits(schema)
                    lines.append(f'Type: {_type(schema)}' + (f' ({limits}).' if limits else '.'))
                discriminator = schema.get('discriminator')
                if discriminator:
                    lines += ['', f'Selected by `{discriminator["propertyName"]}`: ' + ', '.join(
                        f'`{key}` → [{_ref_name({"$ref": target})}](#{_ref_name({"$ref": target}).lower()})'
                        for key, target in discriminator['mapping'].items()) + '.']
    return '\n'.join(lines) + '\n'


def main():
    parser=argparse.ArgumentParser(description=__doc__); parser.add_argument('--check',action='store_true'); args=parser.parse_args()
    native,native_md=native_contracts()
    # The HTML guide that embeds these contracts is built by scripts/build-docs.py.
    model=json.loads((ROOT/'crates/vigo-model/generated/openapi.json').read_text(encoding='utf-8'))
    products={'docs/reference/rust-standalone-native.md':native_md,'docs/reference/api-schema.md':public_schema_reference(model),'docs/standalone-openapi.json':json.dumps(specification(native),indent=2,ensure_ascii=False)+'\n'}
    for name,body in products.items():
        path=ROOT/name
        if args.check:
            assert path.exists() and path.read_text(encoding='utf-8')==body, f'{name} is stale; run npm run docs:standalone'
        else: path.write_text(body, encoding='utf-8')
    print(json.dumps({'status':'current' if args.check else 'generated','files':list(products),'nativeOperations':len(OPERATIONS)+5,'nativeTypes':len(native)}))


if __name__=='__main__': main()
