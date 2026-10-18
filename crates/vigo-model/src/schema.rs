//! JSON Schema and the OpenAPI document, generated from the model types.
//!
//! Results use the serialize contract: a field the engine always writes is
//! required, even when it can be `null`. Requests use the deserialize contract:
//! a field with a default is optional. In both, an optional field is omitted
//! rather than `null` unless it is a [`Maybe`](crate::Maybe).

use crate::{Capabilities, CompareRequest, MatrixRequest, ReachRequest, Response, RouteRequest};
use schemars::generate::SchemaSettings;
use schemars::{JsonSchema, Schema};
use serde_json::{Map, Value, json};

const COMPONENTS: &str = "#/components/schemas/";

/// Marks a `Maybe` field, which can be absent, `null` or a value.
pub(crate) const TRI_STATE: &str = "x-vigo-tri-state";

/// An optional field is omitted rather than `null`, unless it is a `Maybe`:
/// the engine never writes `null` there and rejects it in requests.
fn absent_not_null(schema: &mut Value) {
    match schema {
        Value::Object(object) => {
            let required: Vec<String> = object
                .get("required")
                .and_then(Value::as_array)
                .map(|r| {
                    r.iter()
                        .filter_map(|v| v.as_str().map(str::to_owned))
                        .collect()
                })
                .unwrap_or_default();
            if let Some(Value::Object(properties)) = object.get_mut("properties") {
                for (key, property) in properties.iter_mut() {
                    let tri_state = property
                        .as_object_mut()
                        .and_then(|p| p.remove(TRI_STATE))
                        .is_some();
                    if !tri_state && !required.contains(key) {
                        drop_null(property);
                    }
                }
            }
            object.values_mut().for_each(absent_not_null);
        }
        Value::Array(items) => items.iter_mut().for_each(absent_not_null),
        _ => {}
    }
}

fn drop_null(property: &mut Value) {
    let Some(object) = property.as_object_mut() else {
        return;
    };
    if let Some(Value::Array(kinds)) = object.get_mut("type") {
        kinds.retain(|kind| kind != "null");
        if kinds.len() == 1 {
            let only = kinds[0].clone();
            object.insert("type".into(), only);
        }
    }
    if let Some(Value::Array(branches)) = object.get("anyOf").cloned() {
        let kept: Vec<Value> = branches
            .into_iter()
            .filter(|b| b != &json!({ "type": "null" }))
            .collect();
        if let [single] = kept.as_slice() {
            object.remove("anyOf");
            if let Some(single) = single.as_object() {
                for (key, value) in single {
                    object.entry(key.clone()).or_insert_with(|| value.clone());
                }
            }
        } else {
            object.insert("anyOf".into(), Value::Array(kept));
        }
    }
}

/// Adds a constant `type` property, for structs whose serde tag schemars omits.
pub(crate) fn type_tag(name: &'static str) -> impl Fn(&mut Schema) {
    move |schema: &mut Schema| {
        let object = schema.ensure_object();
        if let Some(Value::Object(properties)) = object.get_mut("properties") {
            properties.insert("type".into(), json!({ "const": name, "type": "string" }));
        }
        if let Value::Array(required) = object.entry("required").or_insert_with(|| json!([])) {
            required.insert(0, json!("type"));
        }
    }
}

fn reference(name: &str) -> Value {
    json!({ "$ref": format!("{COMPONENTS}{name}") })
}

/// Adds `T` and its definitions to `schemas` under one contract, returning a
/// reference to it. A name defined differently by the two contracts is a
/// modeling error.
fn add<T: JsonSchema>(schemas: &mut Map<String, Value>, serialize: bool) -> Value {
    let settings = SchemaSettings::draft2020_12();
    let mut settings = if serialize {
        settings.for_serialize()
    } else {
        settings.for_deserialize()
    };
    settings.definitions_path = "/components/schemas".into();
    let mut generator = settings.into_generator();
    let root = generator.subschema_for::<T>().to_value();
    for (name, mut schema) in generator.take_definitions(true) {
        absent_not_null(&mut schema);
        if let Some(existing) = schemas.get(&name) {
            assert_eq!(
                existing, &schema,
                "{name} differs between the request and Result contracts"
            );
        }
        schemas.insert(name, schema);
    }
    root
}

/// Moves each internally tagged union's tag into the schemas it references,
/// so every Result and leg schema names its own `schema`, `type` or `status`,
/// and gives the union an OpenAPI discriminator.
fn hoist_tags(schemas: &mut Map<String, Value>) {
    let names: Vec<String> = schemas.keys().cloned().collect();
    for name in names {
        let Some(Value::Array(branches)) = schemas[&name].get("oneOf").cloned() else {
            continue;
        };
        let mut tag: Option<String> = None;
        let mut targets: Vec<(String, Vec<String>)> = vec![];
        let tagged = branches.iter().all(|branch| {
            let (Some(target), Some(properties)) = (
                branch.get("$ref").and_then(Value::as_str),
                branch.get("properties").and_then(Value::as_object),
            ) else {
                return false;
            };
            let Some((key, constant)) = properties
                .iter()
                .next()
                .and_then(|(key, value)| Some((key, value.get("const")?.as_str()?)))
            else {
                return false;
            };
            if tag.get_or_insert_with(|| key.clone()) != key {
                return false;
            }
            let target = target.trim_start_matches(COMPONENTS).to_owned();
            match targets.iter_mut().find(|(existing, _)| *existing == target) {
                Some((_, values)) => values.push(constant.to_owned()),
                None => targets.push((target, vec![constant.to_owned()])),
            }
            true
        });
        let (true, Some(tag)) = (tagged, tag) else {
            continue;
        };
        let mut mapping = Map::new();
        for (target, values) in &targets {
            let schema = schemas[target].clone();
            let mut schema: Schema = schema.try_into().expect("schema object");
            let property = match values.as_slice() {
                [value] => json!({ "const": value, "type": "string" }),
                _ => json!({ "enum": values, "type": "string" }),
            };
            let object = schema.ensure_object();
            if let Value::Object(properties) =
                object.entry("properties").or_insert_with(|| json!({}))
            {
                let mut ordered = Map::new();
                ordered.insert(tag.clone(), property);
                ordered.extend(std::mem::take(properties));
                *properties = ordered;
            }
            if let Value::Array(required) = object.entry("required").or_insert_with(|| json!([])) {
                required.insert(0, json!(tag));
            }
            schemas.insert(target.clone(), schema.to_value());
            for value in values {
                mapping.insert(value.clone(), json!(format!("{COMPONENTS}{target}")));
            }
        }
        let union = schemas[&name].as_object().cloned().unwrap_or_default();
        let mut union = union;
        union.insert(
            "oneOf".into(),
            targets
                .iter()
                .map(|(target, _)| reference(target))
                .collect(),
        );
        union.insert(
            "discriminator".into(),
            json!({ "propertyName": tag, "mapping": mapping }),
        );
        schemas.insert(name, Value::Object(union));
    }
}

const AUTH_ERRORS: [(&str, &str); 2] = [
    ("401", "Bearer authentication failed"),
    (
        "403",
        "Tokenless loopback request with a non-local Host or Origin",
    ),
];

const QUERY_ERRORS: [(&str, &str); 11] = [
    ("400", "Invalid request"),
    ("401", "Bearer authentication failed"),
    (
        "403",
        "Tokenless loopback request with a non-local Host or Origin",
    ),
    ("408", "Request read deadline"),
    ("409", "Request ID already active"),
    ("413", "Body limit"),
    ("417", "Unsupported Expect header"),
    ("431", "Header limit"),
    ("499", "Request canceled"),
    ("503", "Capacity or worker unavailable"),
    ("504", "Query deadline or worker failed"),
];

fn json_content(schema: Value) -> Value {
    json!({ "application/json": { "schema": schema } })
}

fn responses(success: (&str, &str, Value), errors: &[(&str, &str)]) -> Map<String, Value> {
    let mut responses = Map::new();
    responses.insert(
        success.0.into(),
        json!({ "description": success.1, "content": json_content(success.2) }),
    );
    for (code, description) in errors {
        responses.insert((*code).into(), json!({ "description": description, "content": json_content(reference("ErrorResult")) }));
    }
    responses
}

fn query(id: &str, summary: &str, request: Value, result: Value, description: &str) -> Value {
    let levels = json!({ "type": "string", "enum": ["none", "summary", "profile", "trace"] });
    let flag = |name: &str, schema: &Value, description: &str| json!({ "in": "query", "name": name, "schema": schema, "description": description });
    json!({ "post": {
        "operationId": id,
        "summary": summary,
        "parameters": [
            flag("diagnostics", &levels, "Diagnostic detail; must agree with the body when both are set."),
            flag("vigo_diagnostics", &levels, "Alias of `diagnostics`."),
            flag("includeGeometry", &json!({ "type": "boolean" }), "Same as the body field."),
            flag("includeLimitations", &json!({ "type": "boolean" }), "Same as the body field."),
        ],
        "requestBody": { "required": true, "content": json_content(request) },
        "responses": responses(("200", description, result), &QUERY_ERRORS),
    } })
}

fn read(id: &str, summary: &str, result: Value, description: &str) -> Value {
    json!({ "get": {
        "operationId": id,
        "summary": summary,
        "responses": responses(("200", description, result), &AUTH_ERRORS),
    } })
}

fn document(summary: &str, media: &str, kind: &str) -> Value {
    json!({ "get": {
        "security": [],
        "summary": summary,
        "responses": { "200": { "description": summary, "content": { media: { "schema": { "type": kind } } } } },
    } })
}

/// The OpenAPI 3.1 document for `vigo serve`. Its schemas are JSON Schema
/// 2020-12, generated from the model types.
pub fn openapi() -> Value {
    let mut schemas = Map::new();
    add::<Response>(&mut schemas, true);
    let capabilities = add::<Capabilities>(&mut schemas, true);
    let route = add::<RouteRequest>(&mut schemas, false);
    let matrix = add::<MatrixRequest>(&mut schemas, false);
    let reach = add::<ReachRequest>(&mut schemas, false);
    let compare = add::<CompareRequest>(&mut schemas, false);
    hoist_tags(&mut schemas);
    // A saved public query Result; internal trace results are also accepted.
    if let Some(Value::Object(properties)) = schemas
        .get_mut("CompareRequest")
        .and_then(|s| s.get_mut("properties"))
    {
        for side in ["before", "after"] {
            let description = properties[side]["description"].clone();
            let mut results = ["RouteResult", "MatrixResult", "ReachResult"]
                .map(reference)
                .to_vec();
            results.push(json!({ "type": "object", "description": "An internal result from `diagnostics: \"trace\"`. Unstable." }));
            properties[side] = json!({ "description": description, "anyOf": results });
        }
    }

    let health = json!({
        "type": "object",
        "properties": {
            "status": { "type": "string", "enum": ["ready", "recovering"] },
            "runtime": { "const": "rust" },
            "version": { "type": "string" },
        },
        "required": ["status", "runtime", "version"],
        "additionalProperties": false,
    });
    let mut paths = Map::new();
    paths.insert(
        "/v1/route".into(),
        query(
            "route",
            "Route",
            route,
            reference("RouteResult"),
            "A journey, or `not_found` when none satisfies the request.",
        ),
    );
    paths.insert(
        "/v1/matrix".into(),
        query(
            "matrix",
            "Matrix",
            matrix,
            reference("MatrixResult"),
            "Travel times for every origin and destination.",
        ),
    );
    paths.insert(
        "/v1/reach".into(),
        query(
            "reach",
            "Reach",
            reach.clone(),
            reference("ReachResult"),
            "Reached area and times.",
        ),
    );
    paths.insert(
        "/v1/isochrone".into(),
        query(
            "isochrone",
            "Reach (alias)",
            reach,
            reference("ReachResult"),
            "Same as `/v1/reach`.",
        ),
    );
    paths.insert(
        "/v1/compare".into(),
        query(
            "compare",
            "Compare saved Results",
            compare,
            reference("CompareResult"),
            "Changes from `before` to `after`.",
        ),
    );
    paths.insert("/v1/native".into(), query("native", "Native operation",
        json!({ "type": "object", "description": "A native kernel operation. Diagnostic; see the native field reference." }),
        json!({ "type": "object", "description": "The kernel's raw output. Diagnostic." }),
        "Raw native output."));
    paths.insert(
        "/v1/info".into(),
        read(
            "info",
            "Info",
            json!({ "oneOf": [reference("InfoResult"), reference("CollectionInfoResult")] }),
            "The loaded City or scenario collection.",
        ),
    );
    paths.insert(
        "/v1/capabilities".into(),
        read(
            "capabilities",
            "Capabilities",
            capabilities,
            "Supported commands, modes and options.",
        ),
    );
    let mut cancel = responses(
        (
            "404",
            "No active request with this ID",
            reference("ErrorResult"),
        ),
        &AUTH_ERRORS,
    );
    cancel.insert("202".into(), json!({ "description": "Cancellation requested; running work is terminated and its worker replaced." }));
    paths.insert("/v1/requests/{id}".into(), json!({ "delete": {
        "operationId": "cancelRequest",
        "summary": "Cancel an active or queued named request",
        "parameters": [{ "name": "id", "in": "path", "required": true, "schema": { "type": "string" } }],
        "responses": cancel,
    } }));
    paths.insert("/healthz".into(), json!({ "get": {
        "operationId": "healthz", "security": [], "summary": "Liveness",
        "responses": { "200": { "description": "Ready, or live while recovering", "content": json_content(health.clone()) } },
    } }));
    paths.insert(
        "/readyz".into(),
        json!({ "get": {
        "operationId": "readyz", "security": [], "summary": "Readiness",
        "responses": {
            "200": { "description": "Ready", "content": json_content(health.clone()) },
            "503": { "description": "Recovering", "content": json_content(health) },
        },
    } }),
    );
    for path in ["/", "/docs", "/docs/"] {
        paths.insert(
            path.into(),
            document("Offline guide", "text/html", "string"),
        );
    }
    for path in [
        "/openapi.json",
        "/docs/openapi.json",
        "/standalone-openapi.json",
        "/docs/standalone-openapi.json",
    ] {
        paths.insert(
            path.into(),
            document("This document", "application/json", "object"),
        );
    }

    json!({
        "openapi": "3.1.0",
        "info": {
            "title": "VIGO API",
            "version": env!("CARGO_PKG_VERSION"),
            "description": "Route, Matrix, Reach and Compare over a prepared City. Generated from the vigo-model types. Bearer authentication is optional only on a loopback listener without a configured token.",
        },
        "servers": [{ "url": "http://127.0.0.1:8080", "description": "Default local listener" }],
        "security": [{ "bearerAuth": [] }],
        "paths": paths,
        "components": {
            "securitySchemes": { "bearerAuth": { "type": "http", "scheme": "bearer" } },
            "schemas": schemas,
        },
    })
}
