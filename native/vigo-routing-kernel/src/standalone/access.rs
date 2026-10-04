//! Read only the access-context columns used by the standalone runtime.
//! The portable City remains shared with Node; editor-only projections and
//! repeated transfer metadata need not become resident JSON object trees.
use serde::Deserialize;
use serde_json::Value;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AccessContext {
    pub schema_version: String,
    pub source_artifact_identity: String,
    pub access_policy_identity: String,
    pub materialized: Materialized,
    pub station_paths: Value,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Materialized {
    pub transfers: Vec<(String, Vec<Transfer>)>,
    pub transfer_shortcuts: Vec<(String, Vec<TransferShortcut>)>,
    pub declared_pathway_stops: Vec<String>,
    pub station_members: Vec<(String, Vec<String>)>,
    pub stop_records: Vec<(String, Value)>,
    pub forbidden_transfer_pairs: Vec<String>,
    pub stop_access_index: AccessIndex,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AccessIndex {
    pub ready: bool,
    pub direct_service_stop_ids: Vec<String>,
    pub departure_service_stop_ids: Vec<String>,
    pub arrival_service_stop_ids: Vec<String>,
}

#[derive(Deserialize)]
pub(crate) struct Transfer {
    pub to_stop_id: String,
    pub min_transfer_time: Option<f64>,
    pub provenance: Option<String>,
    pub path_distance_m: Option<f64>,
}

#[derive(Deserialize)]
pub(crate) struct TransferShortcut {
    pub to_stop_id: String,
    pub min_transfer_time: f64,
    pub steps: Vec<TransferStep>,
}

#[derive(Deserialize)]
pub(crate) struct TransferStep {
    pub from_stop_id: String,
    pub to_stop_id: String,
    pub min_transfer_time: f64,
}
