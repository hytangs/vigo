//! Rebuild a terminal-access overlay with boundary components taken from an
//! existing overlay: `terminal <pbf> <street-index.sqlite> <reference.json>`.
use std::path::Path;

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let reference: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(&args[3]).unwrap()).unwrap();
    let components: Vec<u32> = reference["boundaryComponents"]
        .as_array()
        .unwrap()
        .iter()
        .map(|v| v.as_u64().unwrap() as u32)
        .collect();
    let mut boundary = || Ok(components.clone());
    match vigo_osm::build_terminal_access_store(
        Path::new(&args[1]),
        Path::new(&args[2]),
        &mut boundary,
    ) {
        Ok(result) => println!("{}", result.stringify()),
        Err(error) => println!("error: {error}"),
    }
}
