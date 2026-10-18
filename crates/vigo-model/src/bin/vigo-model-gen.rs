//! Writes the OpenAPI document and the TypeScript and Python types generated
//! from the model into `crates/vigo-model/generated`.
//!
//!     cargo run -p vigo-model --bin vigo-model-gen            # write
//!     cargo run -p vigo-model --bin vigo-model-gen -- --check # fail if stale

use std::path::Path;
use std::process::ExitCode;

fn main() -> ExitCode {
    let check = std::env::args().any(|argument| argument == "--check");
    let directory = Path::new(env!("CARGO_MANIFEST_DIR")).join("generated");
    let mut stale = vec![];
    for (name, contents) in vigo_model::codegen::files() {
        let path = directory.join(name);
        if check {
            if std::fs::read_to_string(&path).ok().as_deref() != Some(contents.as_str()) {
                stale.push(name);
            }
        } else {
            std::fs::create_dir_all(&directory).expect("generated directory");
            std::fs::write(&path, contents).expect("write generated file");
            println!("wrote {}", path.display());
        }
    }
    if stale.is_empty() {
        ExitCode::SUCCESS
    } else {
        eprintln!(
            "Stale generated files: {stale:?}. Run cargo run -p vigo-model --bin vigo-model-gen"
        );
        ExitCode::FAILURE
    }
}
