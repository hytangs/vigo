//! Every recorded Result, and every request the engine accepted, is valid
//! under the generated OpenAPI schemas.

mod common;

use serde_json::{Value, json};

fn validator(openapi: &Value, name: &str) -> jsonschema::Validator {
    // The OpenAPI document is the root, so `#/components/schemas/…` resolves.
    let mut root = openapi.clone();
    root["$ref"] = json!(format!("#/components/schemas/{name}"));
    jsonschema::draft202012::new(&root).unwrap_or_else(|error| panic!("{name}: {error}"))
}

#[test]
fn corpus_is_valid_under_the_generated_schema() {
    let openapi = vigo_model::schema::openapi();
    let names = [
        "Response",
        "Capabilities",
        "RouteRequest",
        "MatrixRequest",
        "ReachRequest",
        "CompareRequest",
    ];
    let validators: Vec<_> = names
        .iter()
        .map(|name| (*name, validator(&openapi, name)))
        .collect();
    let find = |name: &str| &validators.iter().find(|(n, _)| *n == name).unwrap().1;
    let mut report = vec![];
    let mut checked = 0;
    for record in common::records() {
        let kind = record["kind"].as_str().unwrap_or("");
        let mut documents = vec![(
            "result",
            if kind == "capabilities" {
                "Capabilities"
            } else {
                "Response"
            },
        )];
        // A request the engine rejected may be invalid under the schema too.
        if let Some(schema) = common::request_schema(kind)
            .filter(|_| record["exitCode"] == 0 && !record["request"].is_null())
        {
            documents.push(("request", schema));
        }
        for (field, schema) in documents {
            checked += 1;
            if let Some(error) = find(schema).iter_errors(&record[field]).next() {
                report.push(format!(
                    "{} {field}: {error} at {}",
                    record["case"],
                    error.instance_path()
                ));
            }
        }
    }
    assert!(
        report.is_empty(),
        "{checked} documents checked:\n{}",
        report.join("\n")
    );
    eprintln!("{checked} documents valid under the generated schema");
}
