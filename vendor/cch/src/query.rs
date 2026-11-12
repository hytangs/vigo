//! One-shot elimination-tree distance matrix.

use crate::bundle::{CchView, MetricView};

/// Compute a full `sources × targets` distance matrix. Row-major; element
/// `[i * targets.len() + j]` is the distance from `sources[i]` to
/// `targets[j]`. [`crate::INF_WEIGHT`] means unreachable.
///
/// `sources` and `targets` are ORIGINAL dense node ids. This matches
/// routingkit's `cch_compute_distance_matrix` except the unreachable sentinel:
/// this function returns [`crate::INF_WEIGHT`] (`= i32::MAX`) where some
/// routingkit paths return `u32::MAX`.
///
/// It validates the structure and builds its order on every call; repeated
/// matrices on one structure belong on a [`crate::PathQuery`].
#[must_use]
pub fn distance_matrix(
    cch: &CchView,
    metric: &MetricView,
    sources: &[u32],
    targets: &[u32],
) -> Vec<u32> {
    if sources.is_empty() || targets.is_empty() {
        return Vec::new();
    }
    crate::PathQuery::new(cch).distance_matrix(metric, sources, targets)
}
