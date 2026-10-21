//! Stateful service search for trip-scoped interchange and headway service.
//! Labels retain their last vehicle and alighting event. An earlier arrival
//! from another vehicle cannot dominate a legal connection from a later one.
use super::*;
use std::cmp::Ordering;
use std::collections::{BinaryHeap, HashSet};
use std::sync::Arc;

#[derive(Clone, Debug)]
pub struct TransferRule {
    pub from_stop: u32,
    pub to_stop: u32,
    pub from_route: Option<u32>,
    pub to_route: Option<u32>,
    pub from_trip: Option<u32>,
    pub to_trip: Option<u32>,
    pub kind: u8,
    pub minimum: u32,
}
impl TransferRule {
    fn specificity(&self) -> u8 {
        match (
            self.from_trip.is_some(),
            self.to_trip.is_some(),
            self.from_route.is_some(),
            self.to_route.is_some(),
        ) {
            (true, true, _, _) => 6,
            (true, false, _, true) | (false, true, true, _) => 5,
            (true, _, _, _) | (_, true, _, _) => 4,
            (_, _, true, true) => 3,
            (_, _, true, _) | (_, _, _, true) => 2,
            _ => 1,
        }
    }
}
#[derive(Clone, Debug)]
pub struct HeadwayWindow {
    pub trip: u32,
    /// Service-clock bounds at the first stop; end is exclusive.
    pub start: f64,
    pub end: f64,
    pub headway: u32,
}
#[derive(Clone, Default)]
pub struct ServiceSemantics {
    pub rules: Vec<TransferRule>,
    pub trip_routes: Vec<u32>,
    /// Synthetic through-run sequence boundaries map back to physical trips.
    pub physical_trips: Vec<Vec<(u32, u32)>>,
    pub headways: Vec<HeadwayWindow>,
}
pub(super) struct ServiceIndex {
    pub(super) data: Arc<ServiceSemantics>,
    departures: Vec<Vec<usize>>,
    arrivals: Vec<Vec<usize>>,
    headway_departures: Vec<Vec<usize>>,
    headway_arrivals: Vec<Vec<usize>>,
    rules: HashMap<(u32, u32), Vec<usize>>,
    windows: HashMap<u32, Vec<usize>>,
    extra_forward: Vec<Vec<u32>>,
    extra_reverse: Vec<Vec<u32>>,
    forward_classes: Vec<u32>,
    reverse_classes: Vec<u32>,
    forward_identity_stops: Vec<bool>,
    reverse_identity_stops: Vec<bool>,
}
impl ServiceIndex {
    pub(super) fn byte_length(&self) -> usize {
        fn vectors<T>(v: &Vec<Vec<T>>) -> usize {
            v.capacity() * std::mem::size_of::<Vec<T>>()
                + v.iter()
                    .map(|v| v.capacity() * std::mem::size_of::<T>())
                    .sum::<usize>()
        }
        std::mem::size_of::<Self>()
            + self.data.rules.capacity() * std::mem::size_of::<TransferRule>()
            + self.data.headways.capacity() * std::mem::size_of::<HeadwayWindow>()
            + self.data.trip_routes.capacity() * 4
            + vectors(&self.data.physical_trips)
            + vectors(&self.departures)
            + vectors(&self.arrivals)
            + vectors(&self.headway_departures)
            + vectors(&self.headway_arrivals)
            + vectors(&self.extra_forward)
            + vectors(&self.extra_reverse)
            + (self.forward_classes.capacity() + self.reverse_classes.capacity()) * 4
            + self.forward_identity_stops.capacity()
            + self.reverse_identity_stops.capacity()
            + self.rules.capacity() * std::mem::size_of::<((u32, u32), Vec<usize>)>()
            + self.windows.capacity() * std::mem::size_of::<(u32, Vec<usize>)>()
            + self
                .rules
                .values()
                .chain(self.windows.values())
                .map(|v| v.capacity() * std::mem::size_of::<usize>())
                .sum::<usize>()
    }
}
#[derive(Clone)]
struct Label {
    stop: u32,
    clock: f64,
    anchor_clock: f64,
    anchor: u32,
    trip: Option<u32>,
    transfer_class: Option<u32>,
    boardings: u32,
    walking: f64,
    walked: bool,
    scoped_path: bool,
    predecessor: Option<usize>,
    step: JourneyChainStep,
}
#[derive(Clone, Copy)]
struct Queue(f64, usize);
impl PartialEq for Queue {
    fn eq(&self, b: &Self) -> bool {
        self.0 == b.0 && self.1 == b.1
    }
}
impl Eq for Queue {}
impl Ord for Queue {
    fn cmp(&self, b: &Self) -> Ordering {
        b.0.total_cmp(&self.0).then(b.1.cmp(&self.1))
    }
}
impl PartialOrd for Queue {
    fn partial_cmp(&self, b: &Self) -> Option<Ordering> {
        Some(self.cmp(b))
    }
}
type FrontierKey = (u32, Option<u32>, u32, bool, bool);
struct Search {
    labels: Vec<Label>,
    frontiers: HashMap<FrontierKey, Vec<usize>>,
    queue: BinaryHeap<Queue>,
    reverse: bool,
}
impl Search {
    fn retain(&mut self, label: Label) -> Result<()> {
        if self.labels.len() >= MAX_PARETO_LABELS {
            return Err(Error::from_reason(
                "Service search exceeds the bounded label budget",
            ));
        }
        let sign = if self.reverse { -1. } else { 1. };
        let key = (
            label.stop,
            label.transfer_class,
            label.anchor,
            label.walked,
            label.scoped_path,
        );
        let frontier = self.frontiers.entry(key).or_default();
        let dominates = |a: &Label, b: &Label| {
            a.clock * sign <= b.clock * sign
                && a.anchor_clock * sign <= b.anchor_clock * sign
                && a.boardings <= b.boardings
                && a.walking <= b.walking
        };
        if frontier.iter().any(|&i| dominates(&self.labels[i], &label)) {
            return Ok(());
        }
        frontier.retain(|&i| !dominates(&label, &self.labels[i]));
        let i = self.labels.len();
        self.queue.push(Queue(sign * label.clock, i));
        self.labels.push(label);
        frontier.push(i);
        Ok(())
    }
    fn chain(&self, mut index: usize) -> Vec<JourneyChainStep> {
        let mut chain = Vec::new();
        loop {
            let l = &self.labels[index];
            chain.push(l.step);
            match l.predecessor {
                Some(i) => index = i,
                None => break,
            }
        }
        if !self.reverse {
            chain.reverse();
        }
        chain
    }
}
#[derive(Clone)]
struct Completion {
    time: f64,
    boardings: u32,
    walking: f64,
    candidate: u32,
    label: usize,
}
impl TimetableKernel {
    pub fn set_service_semantics(&mut self, data: ServiceSemantics) -> Result<()> {
        let mut index = ServiceIndex {
            data: Arc::new(data),
            departures: vec![vec![]; self.stop_count],
            arrivals: vec![vec![]; self.stop_count],
            headway_departures: vec![vec![]; self.stop_count],
            headway_arrivals: vec![vec![]; self.stop_count],
            rules: HashMap::new(),
            windows: HashMap::new(),
            extra_forward: vec![vec![]; self.stop_count],
            extra_reverse: vec![vec![]; self.stop_count],
            forward_classes: vec![],
            reverse_classes: vec![],
            forward_identity_stops: vec![false; self.stop_count],
            reverse_identity_stops: vec![false; self.stop_count],
        };
        for (i, r) in index.data.rules.iter().enumerate() {
            if r.from_stop as usize >= self.stop_count
                || r.to_stop as usize >= self.stop_count
                || r.kind > 3
            {
                return Err(Error::from_reason("Invalid native transfer rule"));
            }
            index.forward_identity_stops[r.from_stop as usize] |=
                r.from_trip.is_some() || r.from_route.is_some();
            index.reverse_identity_stops[r.to_stop as usize] |=
                r.to_trip.is_some() || r.to_route.is_some();
            index
                .rules
                .entry((r.from_stop, r.to_stop))
                .or_default()
                .push(i);
            if r.kind != 3 && r.from_stop != r.to_stop {
                index.extra_forward[r.from_stop as usize].push(r.to_stop);
                index.extra_reverse[r.to_stop as usize].push(r.from_stop);
            }
        }
        // Incoming identity matters only through transfer-rule selectors. Keep
        // explicitly selected trips distinct; other trips on the same route
        // have identical transfer permissions and can share a dominance class.
        // The label still retains the actual trip for reconstruction/rule lookup.
        let classes = |reverse: bool| {
            let specific: HashSet<u32> = index
                .data
                .rules
                .iter()
                .filter_map(|r| if reverse { r.to_trip } else { r.from_trip })
                .collect();
            let mut ids = HashMap::new();
            (0..self.trip_start.len().saturating_sub(1))
                .map(|trip| {
                    let key = match index.data.trip_routes.get(trip) {
                        Some(&route) if !specific.contains(&(trip as u32)) => (false, route),
                        _ => (true, trip as u32),
                    };
                    let next = ids.len() as u32;
                    *ids.entry(key).or_insert(next)
                })
                .collect()
        };
        index.forward_classes = classes(false);
        index.reverse_classes = classes(true);
        for (i, w) in index.data.headways.iter().enumerate() {
            if w.trip as usize + 1 >= self.trip_start.len()
                || !w.start.is_finite()
                || !w.end.is_finite()
                || w.end <= w.start
                || w.headway == 0
            {
                return Err(Error::from_reason("Invalid native headway window"));
            }
            index.windows.entry(w.trip).or_default().push(i);
        }
        for i in 0..self.departure_seconds.len() {
            if index.windows.contains_key(&self.segment_trip.view()[i]) {
                index.headway_departures[self.from_stop.view()[i] as usize].push(i);
                index.headway_arrivals[self.to_stop.view()[i] as usize].push(i);
            } else {
                index.departures[self.from_stop.view()[i] as usize].push(i);
                index.arrivals[self.to_stop.view()[i] as usize].push(i);
            }
        }
        for departures in &mut index.departures {
            departures.sort_unstable_by_key(|&i| (self.departure_seconds.view()[i], i));
        }
        for arrivals in &mut index.arrivals {
            arrivals.sort_unstable_by_key(|&i| (self.arrival_seconds.view()[i], i));
        }
        for edges in index
            .extra_forward
            .iter_mut()
            .chain(&mut index.extra_reverse)
        {
            edges.sort_unstable();
            edges.dedup();
        }
        self.service = Some(index);
        Ok(())
    }
    fn physical_trip(&self, trip: u32, sequence: u32) -> u32 {
        self.service
            .as_ref()
            .and_then(|s| s.data.physical_trips.get(trip as usize))
            .and_then(|parts| parts.iter().rev().find(|(first, _)| *first <= sequence))
            .map_or(trip, |(_, physical)| *physical)
    }
    fn transfer_rule(
        &self,
        from: u32,
        to: u32,
        from_trip: u32,
        to_trip: u32,
    ) -> Result<Option<&TransferRule>> {
        let s = self.service.as_ref().unwrap();
        let route = |trip: u32| s.data.trip_routes.get(trip as usize).copied();
        let mut best: Option<&TransferRule> = None;
        let mut conflicting = false;
        for &i in s.rules.get(&(from, to)).into_iter().flatten() {
            let r = &s.data.rules[i];
            if r.from_trip.is_some_and(|t| t != from_trip)
                || r.to_trip.is_some_and(|t| t != to_trip)
                || r.from_route.is_some_and(|v| Some(v) != route(from_trip))
                || r.to_route.is_some_and(|v| Some(v) != route(to_trip))
            {
                continue;
            }
            if best.is_none_or(|b| r.specificity() > b.specificity()) {
                best = Some(r);
                conflicting = false;
            } else if best.is_some_and(|b| {
                r.specificity() == b.specificity() && (r.kind != b.kind || r.minimum != b.minimum)
            }) {
                conflicting = true;
            }
        }
        if conflicting {
            return Err(Error::from_reason(
                "Conflicting equally specific GTFS transfer rules",
            ));
        }
        Ok(best)
    }
    #[allow(clippy::too_many_arguments)]
    fn service_search(
        &self,
        stops: &[u32],
        walks: &[f64],
        candidates: &[u32],
        mut start: f64,
        mut end: f64,
        reverse: bool,
        pre: bool,
        maximum: Option<u32>,
        excluded: &[u32],
        distinct_trips: bool,
        target: Option<(&[u32], &[f64], bool)>,
    ) -> Result<Search> {
        if stops.len() != walks.len()
            || stops.len() != candidates.len()
            || stops.iter().any(|&s| s as usize >= self.stop_count)
            || walks.iter().any(|v| !v.is_finite() || *v < 0.)
            || !start.is_finite()
            || !end.is_finite()
            || start < 0.
            || end < start
        {
            return Err(Error::from_reason(
                "Invalid service query bounds or endpoints",
            ));
        }
        if let Some(n) = maximum {
            boarding_layers(Some(n))?;
        }
        let s = self.service.as_ref().unwrap();
        let excluded: HashSet<_> = excluded.iter().copied().collect();
        let sign = if reverse { -1. } else { 1. };
        let initial = if reverse { end } else { start };
        let mut search = Search {
            labels: vec![],
            frontiers: HashMap::new(),
            queue: BinaryHeap::new(),
            reverse,
        };
        for ((&stop, &walk), &candidate) in stops.iter().zip(walks).zip(candidates) {
            let clock = initial + sign * walk;
            if clock < start || clock > end {
                continue;
            }
            search.retain(Label {
                stop,
                clock,
                anchor_clock: clock,
                anchor: stop,
                trip: None,
                transfer_class: None,
                boardings: 0,
                walking: walk,
                walked: false,
                scoped_path: false,
                predecessor: None,
                step: (
                    3,
                    -1,
                    stop as i32,
                    candidate as i32,
                    0.,
                    0.,
                    walk.ceil() as u32,
                    clock,
                ),
            })?;
        }
        let targets: HashMap<u32, f64> = target.map_or_else(HashMap::new, |(stops, walks, _)| {
            let mut targets = HashMap::<u32, f64>::new();
            for (&stop, &walk) in stops.iter().zip(walks) {
                targets
                    .entry(stop)
                    .and_modify(|w| *w = w.min(walk))
                    .or_insert(walk);
            }
            targets
        });
        let mut operations = 0usize;
        while let Some(Queue(_, index)) = search.queue.pop() {
            let l = search.labels[index].clone();
            // Nonnegative ride/walk costs cannot improve an already completed
            // point query beyond this clock. Keep equal clocks for tie-breaking.
            if (!reverse && l.clock > end) || (reverse && l.clock < start) {
                break;
            }
            if l.trip.is_some()
                && !l.scoped_path
                && target.is_some_and(|(_, _, terminal)| terminal || !l.walked)
                && let Some(walk) = targets.get(&l.stop)
            {
                if reverse {
                    start = start.max(l.clock - walk);
                } else {
                    end = end.min(l.clock + walk);
                }
            }
            if !search.frontiers[&(l.stop, l.transfer_class, l.anchor, l.walked, l.scoped_path)]
                .contains(&index)
            {
                continue;
            }
            if !l.walked && (l.trip.is_some() || pre) {
                let (offset, edges, extra) = if reverse {
                    (
                        &self.reverse_transfer_offset,
                        &self.reverse_transfer_edges,
                        &s.extra_reverse,
                    )
                } else {
                    (
                        &self.transfer_offset,
                        &self.transfer_edges,
                        &s.extra_forward,
                    )
                };
                let mut transfers: HashMap<u32, (u32, bool)> = edges
                    [offset[l.stop as usize] as usize..offset[l.stop as usize + 1] as usize]
                    .iter()
                    .map(|e| (e.stop() as u32, (e.duration(), false)))
                    .collect();
                if l.trip.is_some() {
                    for &to in &extra[l.stop as usize] {
                        transfers.entry(to).or_insert((0, true));
                    }
                }
                for (to, (duration, scoped_path)) in transfers {
                    let clock = l.clock + sign * f64::from(duration);
                    if clock < start || clock > end {
                        continue;
                    }
                    let (from, target, arrival) = if reverse {
                        (to, l.stop, l.clock)
                    } else {
                        (l.stop, to, clock)
                    };
                    search.retain(Label {
                        stop: to,
                        clock,
                        walking: l.walking + f64::from(duration),
                        walked: true,
                        scoped_path,
                        predecessor: Some(index),
                        step: (1, from as i32, target as i32, -1, 0., 0., duration, arrival),
                        ..l.clone()
                    })?;
                }
            }
            if maximum.is_some_and(|n| l.boardings >= n) {
                continue;
            }
            let boardings = if reverse {
                &s.arrivals[l.stop as usize]
            } else {
                &s.departures[l.stop as usize]
            };
            // Scheduled candidates outside the current clock interval cannot
            // board. Headway templates have relative clocks and are considered
            // separately, with their real service windows checked below.
            let times = if reverse {
                self.arrival_seconds.view()
            } else {
                self.departure_seconds.view()
            };
            let lower = if reverse { start } else { l.clock };
            let upper = if reverse { l.clock } else { end };
            let first = boardings.partition_point(|&i| f64::from(times[i]) < lower);
            let last = boardings.partition_point(|&i| f64::from(times[i]) <= upper);
            let headways = if reverse {
                &s.headway_arrivals
            } else {
                &s.headway_departures
            };
            for &i in boardings[first..last]
                .iter()
                .chain(&headways[l.stop as usize])
            {
                operations += 1;
                if operations > 50_000_000 {
                    return Err(Error::from_reason(
                        "Service search exceeds the bounded operation budget",
                    ));
                }
                let trip = self.segment_trip.view()[i];
                if excluded.contains(&trip)
                    || (if reverse {
                        self.can_alight.view()[i]
                    } else {
                        self.can_board.view()[i]
                    }) == 0
                {
                    continue;
                }
                let physical = self.physical_trip(trip, self.sequence.view()[i]);
                let mut ready = l.clock;

                if let Some(previous) = l.trip {
                    let rule = if reverse {
                        self.transfer_rule(l.stop, l.anchor, physical, previous)?
                    } else {
                        self.transfer_rule(l.anchor, l.stop, previous, physical)?
                    };
                    if (l.scoped_path && rule.is_none()) || rule.is_some_and(|r| r.kind == 3) {
                        continue;
                    }
                    if rule.is_none()
                        && l.anchor == l.stop
                        && self.forbidden_same_stop[l.stop as usize] != 0
                    {
                        continue;
                    }
                    let minimum = rule.map_or_else(
                        || {
                            if l.anchor == l.stop {
                                self.same_stop_transfer_minimum[l.stop as usize]
                            } else {
                                0
                            }
                        },
                        |r| if r.kind == 2 { r.minimum } else { 0 },
                    );
                    ready = if reverse {
                        ready.min(l.anchor_clock - f64::from(minimum))
                    } else {
                        ready.max(l.anchor_clock + f64::from(minimum))
                    };
                    if !rule.is_some_and(|r| r.kind == 1) {
                        ready += sign * f64::from(self.minimum_transfer_buffer_seconds);
                    }
                }
                let scheduled = if reverse {
                    self.arrival_seconds.view()[i]
                } else {
                    self.departure_seconds.view()[i]
                } as f64;
                let mut shifts = Vec::new();
                if let Some(windows) = s.windows.get(&trip) {
                    let first = self.trip_start.view()[trip as usize] as usize;
                    let offset = scheduled - f64::from(self.departure_seconds.view()[first]);
                    for &wi in windows {
                        let w = &s.data.headways[wi];
                        let wait = f64::from(w.headway).div_euclid(2.) + f64::from(w.headway % 2);
                        let time = if reverse {
                            ready.min(w.end + offset - 1.)
                        } else {
                            ready.max(w.start + offset) + wait
                        };
                        if time >= w.start + offset + wait && time < w.end + offset {
                            shifts.push((time - scheduled, wait));
                        }
                    }
                } else if (scheduled - ready) * sign >= 0. {
                    shifts.push((0., 0.));
                }

                for (shift, wait) in shifts {
                    let run = self.segment_run.view()[i];
                    let mut j = i;
                    loop {
                        let clock = if reverse {
                            f64::from(self.departure_seconds.view()[j]) + shift - wait
                        } else {
                            f64::from(self.arrival_seconds.view()[j]) + shift
                        };
                        // Runs have monotone clocks, including linked physical
                        // trips. Do not scan a whole through-service day after
                        // its remaining calls have passed the query bound.
                        if (!reverse && clock > end) || (reverse && clock < start) {
                            break;
                        }
                        operations += 1;
                        if operations > 50_000_000 {
                            return Err(Error::from_reason(
                                "Service search exceeds the bounded operation budget",
                            ));
                        }
                        let (board, alight) = if reverse { (j, i) } else { (i, j) };
                        if (if reverse {
                            self.can_board.view()[j]
                        } else {
                            self.can_alight.view()[j]
                        }) != 0
                        {
                            let departure = f64::from(self.departure_seconds.view()[board]) + shift;
                            let arrival = f64::from(self.arrival_seconds.view()[alight]) + shift;
                            let clock = if reverse { departure - wait } else { arrival };
                            if clock >= start && clock <= end {
                                let stop = if reverse {
                                    self.from_stop.view()[j]
                                } else {
                                    self.to_stop.view()[j]
                                };
                                let actual = self.physical_trip(trip, self.sequence.view()[j]);
                                if let Some(walk) = targets.get(&stop) {
                                    if reverse {
                                        start = start.max(clock - walk);
                                    } else {
                                        end = end.min(clock + walk);
                                    }
                                }
                                search.retain(Label {
                                    stop,
                                    clock,
                                    anchor_clock: clock,
                                    anchor: stop,
                                    trip: Some(actual),
                                    transfer_class: Some(if distinct_trips {
                                        actual
                                    } else if reverse {
                                        if s.reverse_identity_stops[stop as usize] {
                                            s.reverse_classes[actual as usize]
                                        } else {
                                            0
                                        }
                                    } else {
                                        if s.forward_identity_stops[stop as usize] {
                                            s.forward_classes[actual as usize]
                                        } else {
                                            0
                                        }
                                    }),
                                    boardings: l.boardings + 1,
                                    walking: l.walking,
                                    walked: false,
                                    scoped_path: false,
                                    predecessor: Some(index),
                                    step: (
                                        2,
                                        self.from_stop.view()[board] as i32,
                                        self.to_stop.view()[alight] as i32,
                                        trip as i32,
                                        f64::from(self.sequence.view()[board]),
                                        f64::from(self.sequence.view()[alight]),
                                        (arrival - departure).round() as u32,
                                        arrival,
                                    ),
                                })?;
                            }
                        }
                        let next = if reverse {
                            j.checked_sub(1)
                        } else {
                            j.checked_add(1)
                                .filter(|&n| n < self.departure_seconds.len())
                        };
                        let Some(next) = next else { break };
                        if self.segment_run.view()[next] != run {
                            break;
                        }
                        j = next;
                    }
                }
            }
        }
        Ok(search)
    }
    fn service_completions(
        &self,
        search: &Search,
        stops: &[u32],
        walks: &[f64],
        candidates: &[u32],
        terminal: bool,
        bound: f64,
    ) -> Result<Vec<Completion>> {
        if stops.len() != walks.len()
            || stops.len() != candidates.len()
            || stops.iter().any(|&s| s as usize >= self.stop_count)
            || walks.iter().any(|w| !w.is_finite() || *w < 0.)
        {
            return Err(Error::from_reason("Invalid service destination arrays"));
        }
        let mut targets: HashMap<u32, Vec<(f64, u32)>> = HashMap::new();
        for ((&s, &w), &c) in stops.iter().zip(walks).zip(candidates) {
            targets.entry(s).or_default().push((w, c));
        }
        let mut result = Vec::new();
        for frontier in search.frontiers.values() {
            for &i in frontier {
                let l = &search.labels[i];
                if l.trip.is_none() || l.scoped_path || (!terminal && l.walked) {
                    continue;
                }
                for &(walk, candidate) in targets.get(&l.stop).into_iter().flatten() {
                    let time = l.clock + if search.reverse { -walk } else { walk };
                    if (search.reverse && time < bound) || (!search.reverse && time > bound) {
                        continue;
                    }
                    result.push(Completion {
                        time,
                        boardings: l.boardings,
                        walking: l.walking + walk,
                        candidate,
                        label: i,
                    });
                }
            }
        }
        result.sort_by(|a, b| {
            if search.reverse {
                b.time.total_cmp(&a.time)
            } else {
                a.time.total_cmp(&b.time)
            }
            .then(a.boardings.cmp(&b.boardings))
            .then(a.walking.total_cmp(&b.walking))
            .then(a.candidate.cmp(&b.candidate))
        });
        Ok(result)
    }
}

impl TimetableKernel {
    pub fn headway_seconds(&self, trip: u32, departure: f64, board: f64) -> Option<u32> {
        let service = self.service.as_ref()?;
        if trip as usize + 1 >= self.trip_start.len() {
            return None;
        }
        let first = self.trip_start.view()[trip as usize] as usize;
        if first >= self.departure_seconds.len() {
            return None;
        }
        let offset = self.ride_departure(trip, board).ok()?
            - f64::from(self.departure_seconds.view()[first]);
        service
            .windows
            .get(&trip)?
            .iter()
            .map(|&i| &service.data.headways[i])
            .find(|w| departure >= w.start + offset && departure < w.end + offset)
            .map(|w| w.headway)
    }
    pub fn service_enabled(&self) -> bool {
        self.service.is_some()
    }
    pub(super) fn service_scalar(
        &self,
        input: &TimetableQueryInput,
    ) -> Result<TimetableQueryResult> {
        let started = Instant::now();
        let search = self.service_search(
            &input.origin_stops,
            &input.origin_walk_seconds,
            &input.origin_candidate_indices,
            input.departure,
            input.horizon,
            false,
            input.allow_pre_ride_transfers,
            input.maximum_boardings,
            &[],
            false,
            Some((
                &input.destination_stops,
                &input.destination_walk_seconds,
                input.allow_post_ride_transfers.unwrap_or(true),
            )),
        )?;
        let completions = self.service_completions(
            &search,
            &input.destination_stops,
            &input.destination_walk_seconds,
            &input.destination_candidate_indices,
            input.allow_post_ride_transfers.unwrap_or(true),
            input.horizon,
        )?;
        let mut result = empty_result(started, true, "no_path");
        result.status = "blocked".into();
        if let Some(best) = completions.first() {
            let a = pareto_alternative(
                best.time,
                best.boardings as u16,
                best.walking,
                best.candidate,
                &search.chain(best.label),
            );
            result.status = "ready".into();
            result.reason = None;
            result.best_arrival = Some(a.best_arrival);
            result.best_boardings = Some(a.best_boardings);
            result.best_destination_index = Some(a.best_destination_index);
            result.chain_kinds = a.chain_kinds;
            result.chain_from_stops = a.chain_from_stops;
            result.chain_to_stops = a.chain_to_stops;
            result.chain_trip_or_candidate = a.chain_trip_or_candidate;
            result.chain_board_sequences = a.chain_board_sequences;
            result.chain_alight_sequences = a.chain_alight_sequences;
            result.chain_durations = a.chain_durations;
            result.chain_arrivals = a.chain_arrivals;
        }
        result.relaxed_stops = search.labels.len() as u32;
        result.query_ns = started.elapsed().as_nanos() as f64;
        Ok(result)
    }
    pub(super) fn service_arrive(
        &self,
        input: &TimetableArriveByQueryInput,
    ) -> Result<TimetableArriveByQueryResult> {
        let started = Instant::now();
        let search = self.service_search(
            &input.destination_stops,
            &input.destination_walk_seconds,
            &input.destination_candidate_indices,
            input.earliest,
            input.deadline,
            true,
            input.allow_post_ride_transfers.unwrap_or(true),
            input.maximum_boardings,
            &[],
            false,
            Some((
                &input.origin_stops,
                &input.origin_walk_seconds,
                input.allow_pre_ride_transfers,
            )),
        )?;
        let completions = self.service_completions(
            &search,
            &input.origin_stops,
            &input.origin_walk_seconds,
            &input.origin_candidate_indices,
            input.allow_pre_ride_transfers,
            input.earliest,
        )?;
        Ok(TimetableArriveByQueryResult {
            supported: true,
            status: if completions.is_empty() {
                "blocked"
            } else {
                "ready"
            }
            .into(),
            latest_departure: completions.first().map(|c| c.time),
            candidate_count: completions.len() as u32,
            query_ns: started.elapsed().as_nanos() as f64,
            relaxed_stops: search.labels.len() as u32,
            ..Default::default()
        })
    }
    pub(super) fn service_many(
        &self,
        input: &TimetableManyQueryInput,
    ) -> Result<TimetableManyQueryResult> {
        let started = Instant::now();
        let ids: Vec<_> = (0..input.origin_stops.len() as u32).collect();
        let search = self.service_search(
            &input.origin_stops,
            &input.origin_walk_seconds,
            &ids,
            input.departure,
            input.horizon,
            false,
            input.allow_pre_ride_transfers,
            input.maximum_boardings,
            &input.excluded_trips,
            false,
            None,
        )?;
        let mut times = Vec::new();
        for (i, pair) in input.destination_offsets.windows(2).enumerate() {
            let range = pair[0] as usize..pair[1] as usize;
            let ids: Vec<_> = range.clone().map(|i| i as u32).collect();
            let complete = self.service_completions(
                &search,
                &input.destination_stops[range.clone()],
                &input.destination_walk_seconds[range],
                &ids,
                input
                    .allow_post_ride_transfers
                    .as_ref()
                    .is_none_or(|f| f[i]),
                input.horizon,
            )?;
            times.push(complete.first().map_or(f64::INFINITY, |c| c.time));
        }
        Ok(TimetableManyQueryResult {
            supported: true,
            status: "ready".into(),
            algorithm: "stateful_service".into(),
            best_arrivals: times,
            query_ns: started.elapsed().as_nanos() as f64,
            relaxed_stops: search.labels.len() as u32,
            ..Default::default()
        })
    }
    pub(super) fn service_arrive_many(
        &self,
        input: &TimetableArriveByManyQueryInput,
    ) -> Result<TimetableArriveByManyQueryResult> {
        let started = Instant::now();
        let ids: Vec<_> = (0..input.destination_stops.len() as u32).collect();
        let search = self.service_search(
            &input.destination_stops,
            &input.destination_walk_seconds,
            &ids,
            input.earliest,
            input.deadline,
            true,
            input.allow_post_ride_transfers.unwrap_or(true),
            input.maximum_boardings,
            &input.excluded_trips,
            false,
            None,
        )?;
        let mut times = Vec::new();
        for (i, pair) in input.origin_offsets.windows(2).enumerate() {
            let range = pair[0] as usize..pair[1] as usize;
            let ids: Vec<_> = range.clone().map(|i| i as u32).collect();
            let complete = self.service_completions(
                &search,
                &input.origin_stops[range.clone()],
                &input.origin_walk_seconds[range],
                &ids,
                input.allow_pre_ride_transfers[i],
                input.earliest,
            )?;
            times.push(complete.first().map_or(f64::NEG_INFINITY, |c| c.time));
        }
        Ok(TimetableArriveByManyQueryResult {
            latest_departures: times,
            query_ns: started.elapsed().as_nanos() as f64,
            relaxed_stops: search.labels.len() as u32,
            ..Default::default()
        })
    }
    pub(super) fn service_pareto(
        &self,
        input: &TimetableParetoQueryInput,
    ) -> Result<TimetableParetoQueryResult> {
        let started = Instant::now();
        let bound = input
            .horizon
            .min(input.earliest_arrival + input.arrival_slack_seconds);
        let search = self.service_search(
            &input.origin_stops,
            &input.origin_walk_seconds,
            &input.origin_candidate_indices,
            input.departure,
            bound,
            false,
            input.allow_pre_ride_transfers,
            Some(input.boarding_upper_bound),
            &[],
            input.collect_alternatives.unwrap_or(false),
            None,
        )?;
        let mut completions = self.service_completions(
            &search,
            &input.destination_stops,
            &input.destination_walk_seconds,
            &input.destination_candidate_indices,
            input.allow_post_ride_transfers.unwrap_or(true),
            bound,
        )?;
        let generalized = |c: &Completion| {
            c.time - input.departure
                + f64::from(c.boardings.saturating_sub(1)) * input.transfer_penalty_seconds
                + c.walking * input.walk_reluctance
        };
        completions.sort_by(|a, b| {
            if input.deadline_objective == Some(true) {
                a.boardings
                    .cmp(&b.boardings)
                    .then(a.walking.total_cmp(&b.walking))
                    .then(a.time.total_cmp(&b.time))
            } else {
                generalized(a)
                    .total_cmp(&generalized(b))
                    .then(a.time.total_cmp(&b.time))
                    .then(a.boardings.cmp(&b.boardings))
                    .then(a.walking.total_cmp(&b.walking))
            }
        });
        let mut result = empty_pareto_result(
            started,
            true,
            "no_path",
            ParetoRestrictionMode::parse(None)?,
        );
        result.status = "blocked".into();
        if let Some(best) = completions.first() {
            let a = pareto_alternative(
                best.time,
                best.boardings as u16,
                best.walking,
                best.candidate,
                &search.chain(best.label),
            );
            result.status = "ready".into();
            result.reason = None;
            result.improved_candidate = true;
            result.best_arrival = Some(a.best_arrival);
            result.best_boardings = Some(a.best_boardings);
            result.best_destination_index = Some(a.best_destination_index);
            result.best_walking_seconds = Some(a.best_walking_seconds);
            result.best_generalized_seconds = Some(generalized(best));
            result.chain_kinds = a.chain_kinds;
            result.chain_from_stops = a.chain_from_stops;
            result.chain_to_stops = a.chain_to_stops;
            result.chain_trip_or_candidate = a.chain_trip_or_candidate;
            result.chain_board_sequences = a.chain_board_sequences;
            result.chain_alight_sequences = a.chain_alight_sequences;
            result.chain_durations = a.chain_durations;
            result.chain_arrivals = a.chain_arrivals;
        }
        if input.collect_alternatives == Some(true) {
            let ranked = input.alternative_ranking.as_deref() == Some("ranked");
            let mut selected: Vec<_> = completions
                .iter()
                .filter(|c| {
                    ranked
                        || !completions.iter().any(|a| {
                            a.time <= c.time
                                && a.boardings <= c.boardings
                                && a.walking <= c.walking
                                && (a.time < c.time
                                    || a.boardings < c.boardings
                                    || a.walking < c.walking)
                        })
                })
                .collect();
            if ranked {
                selected.sort_by(|a, b| {
                    a.time
                        .total_cmp(&b.time)
                        .then(a.walking.total_cmp(&b.walking))
                        .then(a.boardings.cmp(&b.boardings))
                        .then(a.candidate.cmp(&b.candidate))
                });
            }
            result.alternatives = Some(
                selected
                    .into_iter()
                    .take(if ranked {
                        input.alternative_limit.unwrap_or(10) as usize
                    } else {
                        usize::MAX
                    })
                    .map(|c| {
                        pareto_alternative(
                            c.time,
                            c.boardings as u16,
                            c.walking,
                            c.candidate,
                            &search.chain(c.label),
                        )
                    })
                    .collect(),
            );
        }
        result.pareto_labels = search.labels.len() as u32;
        result.query_ns = started.elapsed().as_nanos() as f64;
        Ok(result)
    }
}

impl TimetableKernel {
    pub(super) fn service_matrix_journeys(
        &self,
        input: &TimetableMatrixQueryInput,
        mut output: TimetableMatrixQueryResult,
    ) -> Result<TimetableMatrixQueryResult> {
        let destinations = input.destination_offsets.len() - 1;
        let mut journeys = vec![None; output.times.len()];
        for (origin, op) in input.origin_offsets.windows(2).enumerate() {
            for (destination, dp) in input.destination_offsets.windows(2).enumerate() {
                let cell = origin * destinations + destination;
                if !output.times[cell].is_finite() {
                    continue;
                }
                let departure = if input.arrive_by {
                    output.times[cell]
                } else {
                    input.departure
                };
                let horizon = if input.arrive_by {
                    input.horizon
                } else {
                    output.times[cell]
                };
                let o = op[0] as usize..op[1] as usize;
                let d = dp[0] as usize..dp[1] as usize;
                let ids: Vec<_> = o.clone().map(|i| i as u32).collect();
                let dest: Vec<_> = d.clone().map(|i| i as u32).collect();
                let search = self.service_search(
                    &input.origin_stops[o.clone()],
                    &input.origin_walk_seconds[o],
                    &ids,
                    departure,
                    horizon,
                    false,
                    input.allow_pre_ride_transfers[origin],
                    input.maximum_boardings,
                    &[],
                    false,
                    None,
                )?;
                let completions = self.service_completions(
                    &search,
                    &input.destination_stops[d.clone()],
                    &input.destination_walk_seconds[d],
                    &dest,
                    input
                        .allow_post_ride_transfers
                        .as_ref()
                        .is_none_or(|f| f[destination]),
                    horizon,
                )?;
                let best = completions
                    .iter()
                    .min_by(|a, b| {
                        a.boardings
                            .cmp(&b.boardings)
                            .then(a.walking.total_cmp(&b.walking))
                            .then(a.time.total_cmp(&b.time))
                    })
                    .ok_or_else(|| {
                        Error::from_reason("Service matrix bound has no forward witness")
                    })?;
                let mut legs = Vec::new();
                let mut clock = departure;
                let mut ride_seconds = 0.;
                for step in search.chain(best.label) {
                    let ride = step.0 == 2;
                    let start = if ride {
                        step.7 - f64::from(step.6)
                    } else {
                        clock
                    };
                    let end = if ride {
                        step.7
                    } else {
                        start + f64::from(step.6)
                    };
                    if start < clock || end < start {
                        return Err(Error::from_reason("Infeasible service journey"));
                    }
                    if ride {
                        ride_seconds += end - start;
                    }
                    legs.push(TimetableMatrixLeg {
                        kind: if ride { "ride" } else { "walk" }.into(),
                        from_stop: (step.1 >= 0).then_some(step.1 as u32),
                        to_stop: (step.2 >= 0).then_some(step.2 as u32),
                        trip: ride.then_some(step.3 as u32),
                        board_sequence: ride.then_some(step.4),
                        alight_sequence: ride.then_some(step.5),
                        departure: start,
                        arrival: end,
                        in_seat_seconds: None,
                    });
                    clock = end;
                }
                legs.push(TimetableMatrixLeg {
                    kind: "walk".into(),
                    from_stop: Some(input.destination_stops[best.candidate as usize]),
                    to_stop: None,
                    trip: None,
                    board_sequence: None,
                    alight_sequence: None,
                    departure: clock,
                    arrival: best.time,
                    in_seat_seconds: None,
                });
                journeys[cell] = Some(TimetableMatrixJourney {
                    departure,
                    arrival: best.time,
                    boardings: best.boardings,
                    walking_seconds: best.walking,
                    ride_seconds,
                    waiting_seconds: (best.time - departure - best.walking - ride_seconds).max(0.),
                    legs,
                });
            }
        }
        output.journeys = Some(journeys);
        Ok(output)
    }
}

impl TimetableKernel {
    pub(super) fn service_overlay(
        &self,
        input: &TimetableOverlayManyQueryInput,
    ) -> Result<TimetableOverlayManyQueryResult> {
        let started = Instant::now();
        let map_stop = |stop: u32| {
            if stop as usize >= self.stop_count {
                input
                    .overlay_base_stops
                    .get(stop as usize - self.stop_count)
                    .filter(|&&s| s >= 0)
                    .map_or(stop, |&s| s as u32)
            } else {
                stop
            }
        };
        let mut from = Vec::new();
        let mut to = Vec::new();
        let mut duration = Vec::new();
        for (stop, pair) in input.supplemental_transfer_offsets.windows(2).enumerate() {
            for edge in pair[0] as usize..pair[1] as usize {
                from.push(map_stop(stop as u32));
                to.push(map_stop(input.supplemental_transfer_to[edge]));
                duration.push(input.supplemental_transfer_duration[edge]);
            }
        }
        let mut canceled = vec![0; self.trip_start.len() - 1];
        for &trip in &input.excluded_trips {
            let flag = canceled
                .get_mut(trip as usize)
                .ok_or_else(|| Error::from_reason("Invalid excluded overlay trip"))?;
            *flag = 1;
        }
        let times = |values: &[f64]| {
            values
                .iter()
                .map(|&v| finite_u32_time(v, "service scenario time"))
                .collect::<Result<Vec<_>>>()
                .map(U32Buffer::from)
        };
        let view = self.scenario_view(ScenarioPlan {
            added_stop_count: input.overlay_stop_count,
            canceled: canceled.into(),
            canceled_spans: None,
            pattern_offsets: input.direction_offsets.clone().into(),
            pattern_stops: input
                .direction_stops
                .iter()
                .map(|&s| map_stop(s + self.stop_count as u32))
                .collect::<Vec<_>>()
                .into(),
            pattern_departure_offsets: times(&input.direction_stop_offsets_seconds)?,
            pattern_arrival_offsets: times(
                input
                    .direction_arrival_offsets_seconds
                    .as_deref()
                    .unwrap_or(&input.direction_stop_offsets_seconds),
            )?,
            pattern_can_board: input
                .direction_can_board
                .clone()
                .unwrap_or_else(|| vec![1; input.direction_stops.len()])
                .into(),
            pattern_can_alight: input
                .direction_can_alight
                .clone()
                .unwrap_or_else(|| vec![1; input.direction_stops.len()])
                .into(),
            run_start_seconds: times(&input.service_start_seconds)?,
            run_end_seconds: times(&input.service_end_seconds)?,
            run_headway_seconds: times(&input.service_headway_seconds)?,
            added_transfer_from: from.into(),
            added_transfer_to: to.into(),
            added_transfer_duration: duration.into(),
        })?;
        let compile_ns = started.elapsed().as_nanos() as f64;
        let mut kernel = view.kernel;
        let timetable = kernel.route_many_csa(TimetableManyQueryInput {
            origin_stops: input.origin_stops.iter().copied().map(map_stop).collect(),
            origin_walk_seconds: input.origin_walk_seconds.clone(),
            destination_offsets: input.destination_offsets.clone(),
            destination_stops: input
                .destination_stops
                .iter()
                .copied()
                .map(map_stop)
                .collect(),
            destination_walk_seconds: input.destination_walk_seconds.clone(),
            excluded_trips: vec![],
            departure: input.departure,
            horizon: input.horizon,
            allow_pre_ride_transfers: input.allow_pre_ride_transfers,
            allow_post_ride_transfers: input.allow_post_ride_transfers.clone(),
            maximum_boardings: input.maximum_boardings,
        })?;
        Ok(TimetableOverlayManyQueryResult {
            scan_ns: timetable.query_ns,
            timetable,
            overlay_connections: kernel
                .departure_seconds
                .len()
                .saturating_sub(self.departure_seconds.len())
                as u32,
            overlay_runs: view.added_trip_patterns.len() as u32,
            overlay_run_directions: view.added_trip_patterns.to_vec(),
            supplemental_transfer_edges: input.supplemental_transfer_to.len() as u32,
            compile_ns,
            transient_bytes: kernel.diagnostics().array_bytes,
            workspace_bytes: 0.,
            lexicographic_certified: false,
            quality_query_ns: 0.,
            quality_bytes: 0.,
            quality_reason: Some("Reach service scenario returns arrival bounds".into()),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn kernel(rules: Vec<TransferRule>, headways: Vec<HeadwayWindow>) -> TimetableKernel {
        let mut kernel = TimetableKernel::new(TimetableKernelInput {
            stop_count: 3,
            run_count: 3,
            departure_seconds: vec![100, 110, 160].into(),
            arrival_seconds: vec![130, 140, 200].into(),
            from_stop: vec![0, 0, 1].into(),
            to_stop: vec![1, 1, 2].into(),
            sequence: vec![1, 1, 1].into(),
            segment_trip: vec![0, 1, 2].into(),
            segment_run: vec![0, 1, 2].into(),
            continuity_break: vec![1; 3].into(),
            can_board: vec![1; 3].into(),
            can_alight: vec![1; 3].into(),
            trip_start: vec![0, 1, 2, 3].into(),
            departure_offset: vec![0, 2, 3, 3].into(),
            departure_order: vec![0, 1, 2].into(),
            transfer_offset: vec![0; 4].into(),
            transfer_to: vec![].into(),
            transfer_duration: vec![].into(),
            forbidden_same_stop: vec![0; 3].into(),
            same_stop_transfer_minimum: None,
            minimum_transfer_buffer_seconds: None,
        })
        .unwrap();
        kernel
            .set_service_semantics(ServiceSemantics {
                rules,
                trip_routes: vec![0, 1, 2],
                headways,
                ..Default::default()
            })
            .unwrap();
        kernel
    }
    fn rule(from: Option<u32>, kind: u8, minimum: u32) -> TransferRule {
        TransferRule {
            from_stop: 1,
            to_stop: 1,
            from_route: None,
            to_route: None,
            from_trip: from,
            to_trip: Some(2),
            kind,
            minimum,
        }
    }
    fn query(reverse: bool) -> TimetableMatrixQueryInput {
        TimetableMatrixQueryInput {
            origin_offsets: vec![0, 1],
            origin_stops: vec![0],
            origin_walk_seconds: vec![0.],
            allow_pre_ride_transfers: vec![false],
            destination_offsets: vec![0, 1],
            destination_stops: vec![2],
            destination_walk_seconds: vec![0.],
            departure: 90.,
            horizon: 210.,
            arrive_by: reverse,
            allow_post_ride_transfers: Some(vec![false]),
            maximum_boardings: Some(2),
            include_journeys: Some(true),
        }
    }
    #[test]
    fn scoped_search_matches_independent_two_leg_enumeration() {
        for first_kind in [0, 2, 3] {
            for second_kind in [0, 2, 3] {
                for minimum in [0, 20, 21, 30, 31, 60] {
                    let mut kernel = kernel(
                        vec![
                            rule(Some(0), first_kind, minimum),
                            rule(Some(1), second_kind, minimum),
                        ],
                        vec![],
                    );
                    let feasible: Vec<_> = [(100., 130., first_kind), (110., 140., second_kind)]
                        .into_iter()
                        .filter(|(_, arrival, kind)| {
                            *kind != 3
                                && *arrival + if *kind == 2 { f64::from(minimum) } else { 0. }
                                    <= 160.
                        })
                        .collect();
                    let expected = feasible
                        .iter()
                        .map(|(departure, _, _)| *departure)
                        .reduce(f64::max);
                    for reverse in [false, true] {
                        let result = kernel.route_matrix_csa(query(reverse)).unwrap();
                        assert_eq!(result.times[0].is_finite(), expected.is_some());
                        if let Some(departure) = expected {
                            assert_eq!(result.times[0], if reverse { departure } else { 200. });
                        }
                    }
                }
            }
        }
    }
    #[test]
    fn point_bound_preserves_full_search_with_terminal_walks() {
        let kernel = kernel(vec![], vec![]);
        for reverse in [false, true] {
            for walk in [0., 60., 70., 100.] {
                let origins = if reverse { vec![2] } else { vec![0] };
                let targets = if reverse { vec![0, 1] } else { vec![1, 2] };
                let walks = vec![walk, 0.];
                let full = kernel
                    .service_search(
                        &origins,
                        &[0.],
                        &[0],
                        90.,
                        400.,
                        reverse,
                        false,
                        None,
                        &[],
                        false,
                        None,
                    )
                    .unwrap();
                let bounded = kernel
                    .service_search(
                        &origins,
                        &[0.],
                        &[0],
                        90.,
                        400.,
                        reverse,
                        false,
                        None,
                        &[],
                        false,
                        Some((&targets, &walks, true)),
                    )
                    .unwrap();
                let best = |search: &Search| {
                    kernel
                        .service_completions(
                            search,
                            &targets,
                            &walks,
                            &[0, 1],
                            true,
                            if reverse { 90. } else { 400. },
                        )
                        .unwrap()
                        .first()
                        .map(|c| (c.time, c.boardings, c.walking))
                };
                assert_eq!(best(&bounded), best(&full));
            }
        }
    }
    #[test]
    fn equivalent_transfer_classes_match_distinct_trip_frontiers() {
        for rules in [vec![], vec![rule(Some(0), 3, 0)], vec![rule(None, 2, 25)]] {
            let make = || {
                let mut k = kernel(vec![], vec![]);
                k.set_service_semantics(ServiceSemantics {
                    rules: rules.clone(),
                    trip_routes: vec![0, 0, 2],
                    ..Default::default()
                })
                .unwrap();
                k
            };
            let mut grouped = make();
            let mut reference = make();
            let index = reference.service.as_mut().unwrap();
            index.forward_classes = vec![0, 1, 2];
            index.reverse_classes = vec![0, 1, 2];
            index.forward_identity_stops.fill(true);
            index.reverse_identity_stops.fill(true);
            for reverse in [false, true] {
                for start in [90., 100., 105., 111.] {
                    let input = || {
                        let mut input = query(reverse);
                        input.departure = start;
                        input
                    };
                    let actual = grouped.route_matrix_csa(input()).unwrap();
                    let expected = reference.route_matrix_csa(input()).unwrap();
                    assert_eq!(actual.times, expected.times);
                    assert_eq!(
                        serde_json::to_value(actual.journeys).unwrap(),
                        serde_json::to_value(expected.journeys).unwrap()
                    );
                }
            }
        }
    }
    #[test]
    fn headway_boundary_matches_independent_wait_model() {
        let mut kernel = kernel(
            vec![],
            vec![HeadwayWindow {
                trip: 2,
                start: 150.,
                end: 300.,
                headway: 21,
            }],
        );
        for start in 100..310 {
            let mut input = query(false);
            input.origin_stops = vec![1];
            input.departure = f64::from(start);
            input.horizon = 400.;
            let departure = f64::from(start).max(150.) + 11.;
            let result = kernel.route_matrix_csa(input).unwrap();
            assert_eq!(result.times[0].is_finite(), departure < 300.);
            if departure < 300. {
                assert_eq!(result.times[0], departure + 40.);
            }
        }
        for deadline in 170..360 {
            let mut input = query(true);
            input.origin_stops = vec![1];
            input.horizon = f64::from(deadline);
            let boarding = (f64::from(deadline) - 40.).min(299.);
            let expected = boarding - 11.;
            let result = kernel.route_matrix_csa(input).unwrap();
            assert_eq!(result.times[0].is_finite(), boarding >= 161.);
            if boarding >= 161. {
                assert_eq!(result.times[0], expected);
            }
        }
    }
    #[test]
    fn later_legal_arrival_survives_forbidden_earlier_arrival() {
        let mut kernel = kernel(vec![rule(Some(0), 3, 0)], vec![]);
        for reverse in [false, true] {
            let result = kernel.route_matrix_csa(query(reverse)).unwrap();
            assert_eq!(result.times, vec![if reverse { 110. } else { 200. }]);
            let rides: Vec<_> = result.journeys.unwrap()[0]
                .as_ref()
                .unwrap()
                .legs
                .iter()
                .filter_map(|l| l.trip)
                .collect();
            assert_eq!(rides, vec![1, 2]);
        }
    }
    #[test]
    fn specificity_is_order_independent_and_rejects_only_winning_conflicts() {
        let mut forbidden = rule(None, 3, 0);
        forbidden.to_trip = None;
        let mut allowed = forbidden.clone();
        allowed.kind = 0;
        let specific = rule(Some(1), 2, 10);
        let rules = [forbidden.clone(), allowed.clone(), specific];
        for order in [
            [0, 1, 2],
            [0, 2, 1],
            [1, 0, 2],
            [1, 2, 0],
            [2, 0, 1],
            [2, 1, 0],
        ] {
            let kernel = kernel(order.map(|i| rules[i].clone()).to_vec(), vec![]);
            let selected = kernel.transfer_rule(1, 1, 1, 2).unwrap().unwrap();
            assert_eq!((selected.kind, selected.minimum), (2, 10));
            // For another incoming trip, neither generic rule outranks the
            // other: reporting the feed ambiguity is still required.
            assert!(kernel.transfer_rule(1, 1, 0, 2).is_err());
        }
    }
    #[test]
    fn half_headway_wait_has_forward_reverse_witness() {
        let mut kernel = kernel(
            vec![],
            vec![HeadwayWindow {
                trip: 2,
                start: 150.,
                end: 300.,
                headway: 20,
            }],
        );
        for reverse in [false, true] {
            let result = kernel.route_matrix_csa(query(reverse)).unwrap();
            assert_eq!(result.times[0], if reverse { 110. } else { 200. });
            let journey = result.journeys.unwrap()[0].clone().unwrap();
            assert_eq!(journey.arrival, 200.);
        }
    }
}
