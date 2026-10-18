//! The checked-in generated files match the model.

#[test]
fn generated_files_are_current() {
    let directory = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("generated");
    for (name, contents) in vigo_model::codegen::files() {
        let written = std::fs::read_to_string(directory.join(name)).unwrap_or_default();
        assert!(
            written == contents,
            "generated/{name} is stale: run cargo run -p vigo-model --bin vigo-model-gen"
        );
    }
}
