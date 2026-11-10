//! Bicycle matrices share endpoint attachments and hierarchy rank sweeps.
use super::*;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BikeMatrixResult {
    pub seconds: Vec<f64>,
    pub meters: Vec<f64>,
    pub shared_fields: usize,
    pub certified_pairs: usize,
    pub point_queries: usize,
    pub unique_origins: usize,
    pub unique_destinations: usize,
}

fn distinct(points: &[[f64; 2]]) -> (Vec<[f64; 2]>, Vec<usize>) {
    let mut unique = Vec::new();
    let mut index = HashMap::new();
    let indices = points
        .iter()
        .map(|&point| {
            let key = (point[0].to_bits(), point[1].to_bits());
            *index.entry(key).or_insert_with(|| {
                let i = unique.len();
                unique.push(point);
                i
            })
        })
        .collect();
    (unique, indices)
}

impl BikeKernel {
    #[expect(
        clippy::too_many_arguments,
        reason = "Keep routing bounds and attachment policy explicit at the search boundary."
    )]
    pub(crate) fn matrix(
        &self,
        origins: &[[f64; 2]],
        destinations: &[[f64; 2]],
        opt: BikeOptions,
        max_walk: f64,
        walk_speed: f64,
        max_distance: f64,
        clock: Option<BikeClock>,
        arrive: bool,
        max_elapsed: Option<f64>,
    ) -> Result<BikeMatrixResult, String> {
        if origins.is_empty()
            || destinations.is_empty()
            || origins.len().saturating_mul(destinations.len()) > 100_000
        {
            return Err("Bicycle Matrix must contain 1..100000 pairs".into());
        }
        self.validate_request(
            origins[0],
            destinations[0],
            opt,
            max_walk,
            walk_speed,
            max_distance,
            clock,
        )?;
        if origins.iter().chain(destinations).any(|p| {
            !p[0].is_finite() || !p[1].is_finite() || p[0].abs() > 180. || p[1].abs() > 90.
        }) || max_elapsed.is_some_and(|s| !s.is_finite() || s < 0.)
        {
            return Err("Invalid bicycle Matrix coordinates or arrival horizon".into());
        }
        let (unique_origins, rows) = distinct(origins);
        let (unique_destinations, columns) = distinct(destinations);
        let width = unique_destinations.len();
        let mut result = BikeMatrixResult {
            seconds: vec![f64::INFINITY; unique_origins.len() * width],
            meters: vec![f64::INFINITY; unique_origins.len() * width],
            shared_fields: 0,
            certified_pairs: 0,
            point_queries: 0,
            unique_origins: unique_origins.len(),
            unique_destinations: width,
        };
        // A full field must amortize its bounded construction. Smaller batches
        // still benefit from exact coordinate deduplication without a field.
        const MIN_SHARED_TARGETS: usize = 64;
        let shared = (!arrive && width >= MIN_SHARED_TARGETS)
            || (arrive && unique_origins.len() >= MIN_SHARED_TARGETS);
        if shared {
            use surface::hierarchy::batch::{Batch, Request};
            let batch = Batch::new(
                Request {
                    kernel: self,
                    options: opt,
                    max_walk,
                    walk_speed,
                    max_meters: max_distance,
                    clock,
                    arrive,
                    max_elapsed,
                },
                &unique_origins,
                &unique_destinations,
            )?;
            let row_count = if arrive { width } else { unique_origins.len() };
            for i in 0..row_count {
                let row = batch.row(i)?;
                result.shared_fields += 1;
                result.point_queries += row.guards;
                result.certified_pairs += row.seconds.len() - row.guards;
                for (j, (seconds, meters)) in row.seconds.into_iter().zip(row.meters).enumerate() {
                    let index = if arrive { j * width + i } else { i * width + j };
                    result.seconds[index] = seconds;
                    result.meters[index] = meters;
                }
            }
        } else {
            for (i, &origin) in unique_origins.iter().enumerate() {
                for (j, &destination) in unique_destinations.iter().enumerate() {
                    let route = if arrive {
                        self.route_arrive_limited(
                            origin,
                            destination,
                            opt,
                            max_walk,
                            walk_speed,
                            max_distance,
                            clock,
                            max_elapsed,
                        )?
                    } else {
                        self.route_at(
                            origin,
                            destination,
                            opt,
                            max_walk,
                            walk_speed,
                            max_distance,
                            clock,
                        )?
                    };
                    result.point_queries += 1;
                    if route.status == "ready" {
                        result.seconds[i * width + j] = route.elapsed_seconds();
                        result.meters[i * width + j] =
                            route.legs.iter().map(|leg| leg.meters).sum();
                    }
                }
            }
        }
        if unique_origins.len() != origins.len() || width != destinations.len() {
            let expand = |values: &[f64]| {
                rows.iter()
                    .flat_map(|&row| columns.iter().map(move |&col| values[row * width + col]))
                    .collect()
            };
            result.seconds = expand(&result.seconds);
            result.meters = expand(&result.meters);
        }
        Ok(result)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn equal_time_paths_with_different_distances_use_the_point_tie_policy() {
        let paved = (2 << 3) | (30 << 8) | (15 << 14);
        let rough = paved | (1 << 5);
        let nodes = [
            [-0.01, 0.],
            [0., 0.],
            [0.001, 0.001],
            [0.001, -0.001],
            [0.002, 0.],
            [0.012, 0.],
        ];
        let bike = super::super::tests::fixture(
            &nodes,
            &[
                (0, 1, 100000, 1, paved),
                (1, 2, 10000, 2, paved),
                (2, 4, 10000, 3, paved),
                (1, 3, 8500, 4, rough),
                (3, 4, 8500, 5, rough),
                (4, 5, 100000, 6, paved),
            ],
            &[],
        );
        let opt = BikeOptions {
            profile: Profile::Fast,
            ..Default::default()
        };
        for arrive in [false, true] {
            let points: Vec<_> = (1..=64)
                .map(|i| [if arrive { -0.01 } else { 0.002 } + 0.0001 * i as f64, 0.])
                .collect();
            let (origins, destinations) = if arrive {
                (points, vec![nodes[5]])
            } else {
                (vec![nodes[0]], points)
            };
            let batch = bike
                .matrix(
                    &origins,
                    &destinations,
                    opt,
                    0.,
                    4.8,
                    10000.,
                    None,
                    arrive,
                    None,
                )
                .unwrap();
            assert_eq!(batch.shared_fields, 1);
            for (i, &origin) in origins.iter().enumerate() {
                for (j, &destination) in destinations.iter().enumerate() {
                    let point = bike
                        .route_at(origin, destination, opt, 0., 4.8, 10000., None)
                        .unwrap();
                    let cell = i * destinations.len() + j;
                    assert!((batch.seconds[cell] - point.elapsed_seconds()).abs() < 1e-7);
                    // The equal-time paved branch wins the existing tie.
                    let old_distance = if arrive {
                        1200. + 1000. * (1. - (origin[0] + 0.01) / 0.01)
                    } else {
                        1200. + 1000. * (destination[0] - 0.002) / 0.01
                    };
                    let new_distance = point.legs.iter().map(|l| l.meters).sum::<f64>();
                    assert!(
                        (old_distance - new_distance).abs() < 1e-7,
                        "point distance: legacy={old_distance}, hierarchy={new_distance}"
                    );
                    assert!(
                        (batch.meters[cell] - old_distance).abs() < 1e-7,
                        "Matrix distance at {cell} (arrive={arrive}): legacy={old_distance}, hierarchy={}",
                        batch.meters[cell]
                    );
                }
            }
        }
    }

    #[test]
    fn shared_matrix_keeps_point_times_distances_order_and_duplicate_coordinates() {
        let cycle = (2 << 3) | (30 << 8) | (15 << 14);
        let nodes = [[0., 0.], [0.01, 0.]];
        let bike = super::super::tests::fixture(&nodes, &[(0, 1, 100000, 1, cycle)], &[]);
        let targets: Vec<_> = (1..=64).map(|i| [0.0001 * i as f64, 0.]).collect();
        for profile in [Profile::Fast, Profile::Balanced, Profile::Quiet] {
            let opt = BikeOptions {
                profile,
                ..Default::default()
            };
            for arrive in [false, true] {
                let (origins, destinations) = if arrive {
                    (targets.clone(), vec![nodes[1]])
                } else {
                    (vec![nodes[0]], targets.clone())
                };
                let batch = bike
                    .matrix(
                        &origins,
                        &destinations,
                        opt,
                        0.,
                        4.8,
                        10000.,
                        None,
                        arrive,
                        Some(1.),
                    )
                    .unwrap();
                assert_eq!(batch.shared_fields, 1);
                assert!(batch.certified_pairs >= 60);
                for (i, &origin) in origins.iter().enumerate() {
                    for (j, &destination) in destinations.iter().enumerate() {
                        let point = if arrive {
                            bike.route_arrive_limited(
                                origin,
                                destination,
                                opt,
                                0.,
                                4.8,
                                10000.,
                                None,
                                Some(1.),
                            )
                            .unwrap()
                        } else {
                            bike.route_at(origin, destination, opt, 0., 4.8, 10000., None)
                                .unwrap()
                        };
                        let cell = i * destinations.len() + j;
                        assert_eq!(point.status, "ready");
                        assert!((batch.seconds[cell] - point.elapsed_seconds()).abs() < 1e-7);
                        assert!(
                            (batch.meters[cell] - point.legs.iter().map(|l| l.meters).sum::<f64>())
                                .abs()
                                < 1e-7
                        );
                    }
                }
                // Arrival clocks are not a search horizon on undated roads.
                assert!(batch.seconds.iter().all(|&s| s > 1.));
            }
        }
        let batch = bike
            .matrix(
                &[nodes[0], nodes[1], nodes[0]],
                &[targets[4], targets[2], targets[4]],
                Default::default(),
                0.,
                4.8,
                10000.,
                None,
                false,
                None,
            )
            .unwrap();
        assert_eq!(
            (
                batch.unique_origins,
                batch.unique_destinations,
                batch.point_queries
            ),
            (2, 2, 4)
        );
        assert_eq!(batch.seconds[0], batch.seconds[2]);
        assert_eq!(batch.seconds[..3], batch.seconds[6..]);
        assert!(batch.seconds[3..6].iter().all(|s| s.is_infinite()));
        assert!(batch.meters[3..6].iter().all(|s| s.is_infinite()));
        assert!(
            bike.matrix(
                &[],
                &targets,
                Default::default(),
                0.,
                4.8,
                10000.,
                None,
                false,
                None
            )
            .is_err()
        );
        assert!(
            bike.matrix(
                &[[f64::NAN, 0.]],
                &targets,
                Default::default(),
                0.,
                4.8,
                10000.,
                None,
                false,
                None
            )
            .is_err()
        );
    }
}
