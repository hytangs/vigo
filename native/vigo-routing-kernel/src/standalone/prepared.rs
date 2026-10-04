//! Optional reuse of the City compiler's source-bound service snapshot.
//! Missing, stale, or malformed sidecars fall back to SQLite preparation;
//! realtime and modified transfer projections always use the source path.
use super::city::{City, Image, Timetable};
use super::{Result, fail};
use crate::TimetableKernelInput;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{BTreeSet, HashMap, HashSet};

const SCHEMA: &str = "vigo.routing.active-service-kernel.v15-portable";
const TRANSFERS: &str = "single_edge_service_ingress.v6-station-time";

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Metadata {
    schema_version: String,
    kernel: Kernel,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Kernel {
    schema_version: String,
    service_key: String,
    source_artifact_identity: String,
    access_policy_identity: String,
    transfer_projection_version: String,
    transfer_projection_verified: bool,
    run_count: u32,
    active_segment_count: usize,
    stop_ids: Vec<String>,
    trip_ids: Vec<String>,
    route_ids: Vec<String>,
    service_ids: Vec<String>,
}

impl City {
    pub(crate) fn prepared_timetable(
        &self,
        services: &BTreeSet<String>,
        key: String,
        buffer: u32,
    ) -> Result<Timetable> {
        let mut sorted: Vec<_> = services.iter().map(String::as_str).collect();
        // Array.sort in the City compiler compares UTF-16 code units.
        sorted.sort_by(|a, b| a.encode_utf16().cmp(b.encode_utf16()));
        let service_key = format!("services:{}", sorted.join("\u{1f}"));
        #[derive(Serialize)]
        #[serde(rename_all = "camelCase")]
        struct Key<'a> {
            schema_version: &'a str,
            source_artifact_identity: &'a str,
            service_key: &'a str,
            access_policy_identity: &'a str,
        }
        // Declaration order matches the compiler's JSON.stringify identity.
        let identity = serde_json::to_string(&Key {
            schema_version: SCHEMA,
            source_artifact_identity: &self.access.source_artifact_identity,
            service_key: &service_key,
            access_policy_identity: &self.access.access_policy_identity,
        })?;
        let suffix =
            crate::route_materialization::stable_key_suffix(identity.encode_utf16().collect());
        let path = self.path.join(format!(
            "routing/project.sqlite.active-service-kernel.{suffix}.bin"
        ));
        let (image, metadata) = Image::open_with_metadata::<Metadata>(&path)?;
        let saved = metadata.kernel;
        if metadata.schema_version != SCHEMA
            || saved.schema_version != SCHEMA
            || saved.service_key != service_key
            || saved.source_artifact_identity != self.access.source_artifact_identity
            || saved.access_policy_identity != self.access.access_policy_identity
            || saved.transfer_projection_version != TRANSFERS
            || !saved.transfer_projection_verified
            || saved.stop_ids.len() != self.stops.len()
            || saved
                .stop_ids
                .iter()
                .any(|id| !self.stop_index.contains_key(id))
            || saved.stop_ids.iter().collect::<HashSet<_>>().len() != saved.stop_ids.len()
            || saved.trip_ids.len() != saved.route_ids.len()
            || saved.trip_ids.len() != saved.service_ids.len()
            || saved.trip_ids.iter().collect::<HashSet<_>>().len() != saved.trip_ids.len()
            || saved.service_ids.iter().any(|id| !services.contains(id))
        {
            return fail(
                "Prepared timetable identity or dictionaries do not match the active City",
            );
        }
        let departure_seconds = image.u32("departureSeconds")?;
        let trip_start = image.u32("tripStart")?;
        if departure_seconds.len() != saved.active_segment_count
            || trip_start.len() != saved.trip_ids.len() + 1
        {
            return fail("Prepared timetable dimensions do not match its dictionaries");
        }
        let kernel = crate::TimetableKernel::new(TimetableKernelInput {
            stop_count: u32::try_from(saved.stop_ids.len())?,
            run_count: saved.run_count,
            departure_seconds,
            arrival_seconds: image.u32("arrivalSeconds")?,
            from_stop: image.u32("fromStop")?,
            to_stop: image.u32("toStop")?,
            sequence: image.u32("sequence")?,
            segment_trip: image.u32("segmentTrip")?,
            segment_run: image.u32("segmentRun")?,
            continuity_break: image.array("continuityBreak", "Uint8Array", 1)?.to_vec(),
            can_board: image.array("canBoard", "Uint8Array", 1)?.to_vec(),
            can_alight: image.array("canAlight", "Uint8Array", 1)?.to_vec(),
            trip_start,
            departure_offset: image.u32("departureOffset")?,
            departure_order: image.u32("departureOrder")?,
            transfer_offset: image.u32("transferOffset")?,
            transfer_to: image.u32("transferTo")?,
            transfer_duration: image.u32("transferDuration")?,
            forbidden_same_stop: image.array("forbiddenSameStop", "Uint8Array", 1)?.to_vec(),
            same_stop_transfer_minimum: Some(image.u32("sameStopTransferMinimum")?),
            minimum_transfer_buffer_seconds: Some(buffer),
        })?;
        let index: HashMap<_, _> = saved
            .stop_ids
            .iter()
            .enumerate()
            .map(|(i, s)| (s.clone(), i as u32))
            .collect();
        Ok(Timetable {
            kernel,
            index,
            stop_ids: saved.stop_ids,
            trip_ids: saved.trip_ids,
            route_ids: saved.route_ids,
            key,
            realtime: Value::Null,
            preparation: "prepared_snapshot",
        })
    }
}
