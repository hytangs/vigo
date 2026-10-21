use super::*;

impl TimetableKernel {
    pub fn diagnostics(&self) -> TimetableKernelDiagnostics {
        let source_array_bytes = self.departure_seconds.len() * std::mem::size_of::<u32>()
            + self.arrival_seconds.len() * std::mem::size_of::<u32>()
            + self.from_stop.len() * std::mem::size_of::<u32>()
            + self.to_stop.len() * std::mem::size_of::<u32>()
            + self.sequence.len() * std::mem::size_of::<u32>()
            + self.segment_trip.len() * std::mem::size_of::<u32>()
            + self.segment_run.len() * std::mem::size_of::<u32>()
            + self.continuity_break.len() * std::mem::size_of::<u8>()
            + self.can_board.len() * std::mem::size_of::<u8>()
            + self.can_alight.len() * std::mem::size_of::<u8>()
            + self.trip_start.len() * std::mem::size_of::<u32>()
            + self.forbidden_same_stop.len() * std::mem::size_of::<u8>()
            + self.same_stop_transfer_minimum.len() * std::mem::size_of::<u32>();
        let native_index_bytes = self.service.as_ref().map_or(0, |s| s.byte_length())
            + self.departure_events.capacity() * std::mem::size_of::<DepartureEvent>()
            + self.departure_offset.capacity() * std::mem::size_of::<u32>()
            + self.transfer_edges.capacity() * std::mem::size_of::<TransferEdge>()
            + self.transfer_offset.capacity() * std::mem::size_of::<u32>()
            + self.scan_events.capacity() * std::mem::size_of::<ScanEvent>()
            + self.scan_times.capacity() * std::mem::size_of::<u32>()
            + self.scan_time_offsets.capacity() * std::mem::size_of::<u32>()
            + self.scan_time_needs_closure.capacity() * std::mem::size_of::<bool>()
            + self.scan_arrivals.capacity() * std::mem::size_of::<ScanArrival>()
            + self.scan_journeys.capacity() * std::mem::size_of::<ScanJourney>()
            + self.run_start.capacity() * std::mem::size_of::<u32>()
            + self.run_end.capacity() * std::mem::size_of::<u32>()
            + self.reverse_transfer_offset.capacity() * std::mem::size_of::<u32>()
            + self.reverse_transfer_edges.capacity() * std::mem::size_of::<TransferEdge>()
            + self.exit_event_offset.capacity() * std::mem::size_of::<u32>()
            + self.exit_events.capacity() * std::mem::size_of::<ExitEvent>();
        let array_bytes = source_array_bytes + native_index_bytes;
        TimetableKernelDiagnostics {
            stop_count: self.stop_count as u32,
            state_count: (self.stop_count * STATE_STRIDE) as u32,
            segment_count: self.departure_seconds.len() as u32,
            trip_count: self.trip_start.len().saturating_sub(1) as u32,
            run_count: self.run_count as u32,
            transfer_count: self.transfer_edges.len() as u32,
            transfer_board_slack_seconds: f64::from(self.minimum_transfer_buffer_seconds),
            workspace_bytes: self.query.byte_length() as f64,
            source_array_bytes: source_array_bytes as f64,
            native_index_bytes: native_index_bytes as f64,
            array_bytes: array_bytes as f64,
            zero_copy_arrays: self.departure_seconds.is_external(),
            algorithm: if self.service.is_some() {
                "stateful_service_search"
            } else {
                "exact_connection_scan_no_heuristic"
            }
            .to_owned(),
        }
    }
}
