# AI use

AI was used heavily in both building the artifact and running its Ask and rider-draft features. This record separates those uses.

## Development assistance

Codex, identified in the session as GPT-6, inspected the repository and the supplied brief, designed the Agency additions, wrote and revised code, ran checks, inspected the browser, generated the synthetic figure, and prepared commits. No subagents were used. The user provided the product scope, required compatibility with VIGO’s design, prohibited changes to the original VIGO checkout, and corrected the AI setup and readability of Ask during development.

The implementation reused VIGO’s existing React shell, CSS tokens, map, importer, realtime decoder, and native routing adapters. Local Chat and VEXTA were inspected for useful provider-connection and status patterns. Their source implementations were not copied. Public GTFS and Ollama documentation informed data interpretation and provider compatibility.

New AI-assisted code covers the operational context, departure comparisons, observation history, typed tools, restricted SQL worker, provider setup, query planning, rider drafts, server integration, UI, and focused tests. The native routing implementation was not rewritten. Existing VIGO code and documentation remain prior work; they are not claimed as newly developed for this task.

## AI inside the product

Ask sends the question, a compact City summary, tool definitions, and selected tool results to the configured provider. The model chooses tool calls. The application executes them, records their sources, and displays an activity trail separately from the answer. Tool steps are public workflow information, not private internal model reasoning.

Operational answer sentences and values come from tool results. Unrestricted model prose is not used as a substitute for those facts. For rider information, a model can select and arrange a constrained set of event-derived sentences. The product labels these outputs as drafts and has no publication action. Live comparisons and built-in workflows do not require a model.

The live tests used the existing local Ollama installation and **Qwen3.5:4b**. A model-list response was not treated as proof of inference: the connection flow made a real function call. The first larger Ask request timed out. Development then added explicit reasoning controls, smaller model context, and retention of completed evidence after a provider failure. Subsequent checks exercised a network question, departure-gap investigation, and rider draft. These are individual functional checks, not an accuracy benchmark.

## Documentation and graphics

**README.md, ASSUMPTIONS.md, and this file were drafted by Codex.** Their statements are based on the implemented code, terminal results, public resources, and retained examples. They should not be described as entirely human-authored or as the user’s unaided writing. Independent human line-by-line review was not recorded during this session.

The City X figure was generated programmatically from a synthetic fixture through the production comparison code. Browser images are screenshots of the running application. No image-generation model was used. Boston examples are public-feed observations with timestamps; synthetic examples are labeled separately.

## Verification and remaining uncertainty

Focused tests cover calendar handling, exact identities, missing departures, independent feed freshness, alert activity, SQL restrictions and process termination, query planning, provider keys, workflow settings, and rider-draft constraints. Existing UI, map, GTFS, security, build, and packaged-runtime checks were also run. Browser checks covered phone widths, keyboard tabs, model setup, streamed activity, and evidence inspection.

These checks do not establish agency adoption, safety of operational interventions, general model accuracy, or superiority to TransitGPT. The model can still choose an inappropriate query, and the deliberately constrained narrative cannot explain every question. The source query, observation time, and limitations remain inspectable so a reader can assess what the answer supports.

The Codex subscription/access tier was not exposed in the session. No remote inference key was configured for the runtime tests. The compute environment and elapsed task time are recorded in README.md.
