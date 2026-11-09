//! Sparse forward turn states used when traversing the graph toward a deadline.
//! The geometric closure contains every forward restriction state. Queries
//! must still check the exact forward transition at its dated movement time;
//! reversing an edge never reverses an only-turn rule.
use super::*;

#[derive(Clone)]
pub(super) struct ArrivalState {
    pub node: u32,
    pub incoming: u32,
    pub turns: u32,
}

pub(super) struct ArrivalStates {
    pub extra: Vec<ArrivalState>,
    pub turns: Vec<TurnState>,
    pub at: HashMap<u32, Vec<u32>>,
    pub ids: HashMap<(u32, u32, u32), u32>,
    pub turn_ids: HashMap<TurnState, u32>,
    nodes: u32,
}
impl ArrivalStates {
    pub fn state(&self, id: u32) -> ArrivalState {
        if id < self.nodes {
            ArrivalState {
                node: id,
                incoming: u32::MAX,
                turns: 0,
            }
        } else {
            self.extra[(id - self.nodes) as usize].clone()
        }
    }
    pub fn variants(&self, node: u32) -> impl Iterator<Item = u32> + '_ {
        std::iter::once(node).chain(self.at.get(&node).into_iter().flatten().copied())
    }
    fn insert(&mut self, node: u32, incoming: u32, state: TurnState) -> Result<u32, String> {
        let turns = if state.is_empty() {
            0
        } else {
            *self.turn_ids.entry(state.clone()).or_insert_with(|| {
                let id = self.turns.len() as u32;
                self.turns.push(state);
                id
            })
        };
        if incoming == u32::MAX && turns == 0 {
            return Ok(node);
        }
        let key = (node, incoming, turns);
        if let Some(&id) = self.ids.get(&key) {
            return Ok(id);
        }
        let id = u32::try_from(self.nodes as usize + self.extra.len())
            .map_err(|_| "Bicycle turn state index exceeds its address range")?;
        if self.extra.len() >= crate::resources::cache_budget(256 * 1024 * 1024, 16) / 128 {
            return Err("Bicycle turn states exceed their bounded workspace".into());
        }
        self.extra.push(ArrivalState {
            node,
            incoming,
            turns,
        });
        self.at.entry(node).or_default().push(id);
        self.ids.insert(key, id);
        Ok(id)
    }
    pub fn build(kernel: &BikeKernel) -> Result<Self, String> {
        let mut graph = Self {
            extra: vec![],
            turns: vec![vec![]],
            at: HashMap::new(),
            ids: HashMap::new(),
            turn_ids: HashMap::from([(vec![], 0)]),
            nodes: kernel.lons.len() as u32,
        };
        // Starting partway along a road has no earlier via-way history. These
        // incoming-edge states also cover the local node-turn restrictions.
        for (edge, &attr) in kernel.attributes.iter().enumerate() {
            if attr & (NODE_TURN | WAY_TURN) != 0 {
                graph.insert(kernel.targets[edge], edge as u32, vec![])?;
            }
        }
        let mut cursor = 0;
        while cursor < graph.extra.len() {
            let source = graph.extra[cursor].clone();
            cursor += 1;
            let state = graph.turns[source.turns as usize].clone();
            let incoming = (source.incoming != u32::MAX).then_some(source.incoming);
            let starting = incoming
                .filter(|&edge| kernel.attributes[edge as usize] & WAY_TURN != 0)
                .and_then(|edge| {
                    kernel
                        .way_starts
                        .get(&(source.node, kernel.ways[edge as usize]))
                });
            for edge in
                kernel.offsets[source.node as usize]..kernel.offsets[source.node as usize + 1]
            {
                let way = kernel.ways[edge as usize];
                let next_incoming =
                    if kernel.attributes[edge as usize] & (NODE_TURN | WAY_TURN) != 0 {
                        edge
                    } else {
                        u32::MAX
                    };
                let group = |id: u32, start: u32| {
                    let r = &kernel.way_turns[id as usize];
                    (start, r.from, if r.independent { id + 1 } else { 0 })
                };
                let mut continued = Vec::new();
                let mut completions = Vec::new();
                for &(id, step, start) in &state {
                    let rule = &kernel.way_turns[id as usize];
                    let next_step = if way == rule.via[step as usize] {
                        Some(step)
                    } else if rule.via.get(step as usize + 1) == Some(&way) {
                        Some(step + 1)
                    } else {
                        None
                    };
                    if let Some(step) = next_step {
                        continued.push((id, step, start));
                    }
                    if rule.only
                        && next_step.is_none()
                        && step as usize + 1 == rule.via.len()
                        && way == rule.to
                    {
                        let key = group(id, start);
                        if !completions.contains(&key) {
                            completions.push(key);
                        }
                    }
                }
                // A completion may release its only-turn group. Retain both
                // geometric possibilities here; the query checks the actual
                // permissions and exact forward transition before using either.
                let mut variants = vec![continued];
                for key in completions {
                    let count = variants.len();
                    for i in 0..count {
                        let mut next = variants[i].clone();
                        next.retain(|&(id, _, start)| {
                            !kernel.way_turns[id as usize].only || group(id, start) != key
                        });
                        if next != variants[i] {
                            variants.push(next);
                        }
                    }
                    if variants.len() > 65536 {
                        return Err(
                            "Bicycle turn completion states exceed their bounded workspace".into(),
                        );
                    }
                }
                for mut next in variants {
                    for &id in starting.into_iter().flatten() {
                        if kernel.way_turns[id as usize].via[0] == way {
                            next.push((id, 0, source.node));
                        }
                    }
                    next.sort_unstable();
                    next.dedup();
                    graph.insert(kernel.targets[edge as usize], next_incoming, next)?;
                }
            }
        }
        Ok(graph)
    }
}
impl BikeKernel {
    /// Latest legal forward movement that produces the required downstream
    /// turn history. The clock runs backward; the restriction automaton does
    /// not. Earlier openings are crossed at their representable boundary.
    #[expect(
        clippy::too_many_arguments,
        reason = "Keep arrival state and clock bounds explicit."
    )]
    pub(super) fn latest_arrival_movement(
        &self,
        history: &TurnState,
        incoming: Option<u32>,
        node: u32,
        edge: u32,
        required: Option<&TurnState>,
        clock: Option<BikeClock>,
        latest: f64,
        earliest: f64,
        kind: SearchKind<'_>,
    ) -> Result<Option<f64>, String> {
        if latest < earliest || (!latest.is_finite() || !earliest.is_finite()) {
            return Ok(None);
        }
        if clock.is_none() && self.attributes[edge as usize] & TIMED_EDGE != 0 {
            return Ok(None);
        }
        if history.is_empty()
            && incoming
                .is_none_or(|edge| self.attributes[edge as usize] & (NODE_TURN | WAY_TURN) == 0)
            && self.attributes[edge as usize] & TIMED_EDGE == 0
        {
            return Ok(required
                .is_none_or(|state| state.is_empty())
                .then_some(latest));
        }
        let mut at = latest;
        let mut cycle_start = earliest.max(latest - 8. * 86400.);
        for _ in 0..4096 {
            let shifted = clock.map(|c| BikeClock {
                epoch: c.epoch + at,
                ..c
            });
            if shifted.is_some_and(|c| {
                chrono::DateTime::from_timestamp(c.epoch.floor() as i64, 0).is_none()
            }) {
                return Err("Bicycle arrival exceeded the supported calendar range".into());
            }
            let search = if kind.relaxed() {
                kind
            } else {
                SearchKind::Frozen
            };
            if let Some((_, next)) = self
                .movements(history, incoming, node, edge, shifted, 0., search, false)?
                .first
                && required.is_none_or(|state| *state == next)
            {
                return Ok(Some(at));
            }
            if kind.relaxed() {
                return Ok(None);
            }
            let Some(clock) = clock else {
                return Ok(None);
            };
            let turns = incoming
                .filter(|&edge| self.attributes[edge as usize] & NODE_TURN != 0)
                .and_then(|edge| self.turns.get(&(node, self.ways[edge as usize])))
                .map_or(&[][..], |turns| &turns[..]);
            let starting = incoming
                .filter(|&edge| self.attributes[edge as usize] & WAY_TURN != 0)
                .and_then(|edge| self.way_starts.get(&(node, self.ways[edge as usize])))
                .map_or(&[][..], |ids| &ids[..]);
            let edge_window = self.edge_windows.get(&edge).copied();
            let previous = turns
                .iter()
                .map(|t| t.window)
                .chain(edge_window)
                .chain(
                    history
                        .iter()
                        .map(|&(id, _, _)| self.way_turns[id as usize].window),
                )
                .chain(
                    starting
                        .iter()
                        .map(|&id| self.way_turns[id as usize].window),
                )
                .filter_map(|id| self.windows.previous_change(id, clock, at))
                .max_by(f64::total_cmp);
            let Some(previous) = previous else {
                return Ok(None);
            };
            if clock.offset_changes_at(previous)? {
                cycle_start = earliest.max(previous - 8. * 86400.);
            }
            let before = ((clock.epoch + previous).next_down() - clock.epoch).min(at.next_down());
            if before < cycle_start {
                return Ok(None);
            }
            at = before;
        }
        Err("Bicycle arrival movement exceeded its change limit".into())
    }
}
