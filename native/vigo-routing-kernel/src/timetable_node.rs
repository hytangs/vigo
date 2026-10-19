//! Temporary Node-API adapter. Computation and validation live in the workspace
//! crates. Typed arrays retain their original owner across this boundary.
use napi::bindgen_prelude::*;
use napi_derive::napi;

include!(concat!(env!("OUT_DIR"), "/timetable_objects.rs"));

fn node_error(error: vigo_route::Error) -> napi::Error {
    let status = match error.code {
        vigo_route::ErrorCode::InvalidInput => napi::Status::InvalidArg,
        vigo_route::ErrorCode::OperationFailed => napi::Status::GenericFailure,
    };
    napi::Error::new(status, error.reason)
}

#[napi]
pub struct TimetableKernel {
    inner: vigo_route::timetable::TimetableKernel,
}

#[napi]
impl TimetableKernel {
    #[napi(constructor)]
    pub fn new(input: TimetableKernelInput) -> Result<Self> {
        vigo_route::timetable::TimetableKernel::new(input.into())
            .map(|inner| Self { inner })
            .map_err(node_error)
    }
    #[napi]
    pub fn route_scalar_csa(&mut self, input: TimetableQueryInput) -> Result<TimetableQueryResult> {
        self.inner
            .route_scalar_csa(input.into())
            .map(Into::into)
            .map_err(node_error)
    }
    #[napi]
    pub fn route_arrive_by_csa(
        &mut self,
        input: TimetableArriveByQueryInput,
    ) -> Result<TimetableArriveByQueryResult> {
        self.inner
            .route_arrive_by_csa(input.into())
            .map(Into::into)
            .map_err(node_error)
    }
    #[napi]
    pub fn route_matrix_csa(
        &mut self,
        input: TimetableMatrixQueryInput,
    ) -> Result<TimetableMatrixQueryResult> {
        self.inner
            .route_matrix_csa(input.into())
            .map(Into::into)
            .map_err(node_error)
    }
    #[napi]
    pub fn route_arrive_by_many_csa(
        &mut self,
        input: TimetableArriveByManyQueryInput,
    ) -> Result<TimetableArriveByManyQueryResult> {
        self.inner
            .route_arrive_by_many_csa(input.into())
            .map(Into::into)
            .map_err(node_error)
    }
    #[napi]
    pub fn route_many_csa(
        &mut self,
        input: TimetableManyQueryInput,
    ) -> Result<TimetableManyQueryResult> {
        self.inner
            .route_many_csa(input.into())
            .map(Into::into)
            .map_err(node_error)
    }
    #[napi]
    pub fn route_overlay_many_csa(
        &mut self,
        input: TimetableOverlayManyQueryInput,
    ) -> Result<TimetableOverlayManyQueryResult> {
        self.inner
            .route_overlay_many_csa(input.into())
            .map(Into::into)
            .map_err(node_error)
    }
    #[napi]
    pub fn route_alternatives_csa(
        &mut self,
        input: TimetableAlternativeQueryInput,
    ) -> Result<TimetableParetoQueryResult> {
        self.inner
            .route_alternatives_csa(input.into())
            .map(Into::into)
            .map_err(node_error)
    }
    #[napi]
    pub fn route_pareto_round_csa(
        &mut self,
        input: TimetableParetoQueryInput,
    ) -> Result<TimetableParetoQueryResult> {
        self.inner
            .route_pareto_round_csa(input.into())
            .map(Into::into)
            .map_err(node_error)
    }
    #[napi]
    pub fn diagnostics(&self) -> TimetableKernelDiagnostics {
        self.inner.diagnostics().into()
    }
}

#[napi]
pub fn prepare_timetable_indexes(
    input: TimetablePreparationInput,
) -> Result<TimetablePreparationResult> {
    vigo_route::timetable::prepare_timetable_indexes(input.into())
        .map(Into::into)
        .map_err(node_error)
}
#[napi]
pub fn compile_transfer_paths(input: TransferPathInput) -> Result<TransferPathResult> {
    vigo_route::timetable::compile_transfer_paths(input.into())
        .map(Into::into)
        .map_err(node_error)
}
#[napi]
pub fn compile_station_paths(input: StationPathsInput) -> Result<StationPathsResult> {
    vigo_route::timetable::compile_station_paths(input.into())
        .map(Into::into)
        .map_err(node_error)
}
#[napi]
pub fn validate_station_paths(input: StationPathsValidationInput) -> Result<()> {
    vigo_route::timetable::validate_station_paths(input.into()).map_err(node_error)
}
#[napi]
pub fn compile_scenario_timetable(
    input: ScenarioTimetableInput,
) -> Result<ScenarioTimetableResult> {
    vigo_route::timetable::compile_scenario_timetable(input.into())
        .map(Into::into)
        .map_err(node_error)
}
#[napi]
pub fn compile_realtime_timetable(
    input: RealtimeTimetableInput,
) -> Result<RealtimeTimetableResult> {
    vigo_route::timetable::compile_realtime_timetable(input.into())
        .map(Into::into)
        .map_err(node_error)
}
#[napi]
pub fn read_service_timetable(input: ServiceTimetableInput) -> Result<ServiceTimetableResult> {
    vigo_format::read_service_timetable(input.into())
        .map(Into::into)
        .map_err(node_error)
}
#[napi]
pub fn compile_gtfs_connections(input: GtfsConnectionInput) -> Result<GtfsConnectionResult> {
    vigo_prepare::compile_gtfs_connections(input.into())
        .map(Into::into)
        .map_err(node_error)
}

pub(crate) fn boarding_layers(maximum: Option<u32>) -> Result<usize> {
    vigo_route::timetable::boarding_layers(maximum).map_err(node_error)
}

#[napi]
pub fn encode_routing_snapshot(
    metadata_json: Option<String>,
    arrays: Vec<PortableArray>,
) -> Result<napi::bindgen_prelude::Buffer> {
    let arrays: Vec<_> = arrays.into_iter().map(Into::into).collect();
    vigo_format::encode_routing_snapshot(metadata_json.as_deref(), &arrays)
        .map(Into::into)
        .map_err(|error| napi::Error::from_reason(error.to_string()))
}
