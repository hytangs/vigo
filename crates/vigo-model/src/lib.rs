//! The public VIGO contract: the requests the engine accepts and the Results it
//! returns, typed, with their JSON Schema.
//!
//! Every type serializes to the JSON VIGO 1.0.0-rc.2 writes, field for field. The
//! golden corpus in `test/corpus` holds Results recorded from the executable;
//! `tests/corpus.rs` reads each one into these types and writes it back
//! unchanged. Schema, OpenAPI, TypeScript and Python files in `generated/` are
//! produced from these types by `vigo-model-gen`.
//!
//! Fields documented as diagnostic (`trace`, `memory`, `residency`) are kept as
//! raw JSON: they are outside the stability policy.

mod capabilities;
pub mod codegen;
mod common;
mod journey;
mod number;
mod request;
mod result;
pub mod schema;

pub use capabilities::*;
pub use common::*;
pub use journey::*;
pub use number::Number;
pub use request::*;
pub use result::*;
