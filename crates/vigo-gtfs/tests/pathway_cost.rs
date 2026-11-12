//! Estimated pathway seconds, ported from test/check-pathway-cost-model.mjs.
use vigo_gtfs::store::policy::estimated_pathway_seconds;
use vigo_gtfs::zip::{Header, Row};

fn estimate(fields: &[(&str, &str)]) -> vigo_gtfs::Result<Option<f64>> {
    let header = Header {
        names: fields.iter().map(|(name, _)| (*name).to_owned()).collect(),
    };
    let values: Vec<String> = fields
        .iter()
        .map(|(_, value)| (*value).to_owned())
        .collect();
    let row = Row {
        header: &header,
        values,
    };
    estimated_pathway_seconds(&row)
}

#[test]
fn stair_counts_price_one_second_per_step() {
    assert_eq!(
        estimate(&[("pathway_mode", "2"), ("stair_count", "-33")]).unwrap(),
        Some(33.0)
    );
    let error = estimate(&[("pathway_mode", "2"), ("stair_count", "1.5")]).unwrap_err();
    assert!(error.to_string().contains("stair_count"), "{error}");
}
