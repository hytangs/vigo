//! GTFS transfer-rule selectors, ranked as GTFS specifies. Flex interchanges
//! resolve the rule that applies to a conditional leg with them.
use super::*;

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
    /// Parent-station hops from the matched stops up to the rule's stop
    /// selectors; 0 when the rule names both stops directly.
    pub stop_depth: u8,
}
impl TransferRule {
    /// Resolve matching selectors identically for scheduled and conditional legs.
    pub fn select_most_specific<'a>(
        rules: impl IntoIterator<Item = &'a Self>,
    ) -> Result<Option<&'a Self>> {
        let mut best: Option<&Self> = None;
        let mut conflicting = false;
        for r in rules {
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
    /// GTFS ranks trip and route selectors. Among equal selectors, a rule
    /// naming the platforms overrides one inherited from their station.
    fn specificity(&self) -> (u8, std::cmp::Reverse<u8>) {
        let selectors = match (
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
        };
        (selectors, std::cmp::Reverse(self.stop_depth))
    }
}
