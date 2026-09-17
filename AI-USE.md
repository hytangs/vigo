# AI Use

VIGO Agency was AI-native (developed with extensive AI coding and assistance), but AI was used at different levels across different stages of the project.

There were roughly four stages of work this week:

## 1. Idea generation

The idea of VIGO Agency itself was 100% human-generated. I proposed the full project direction, the early software scope, and what I wanted the system to do. ChatGPT Pro was used to discuss feasibility, challenge ideas, and suggest possible scope improvements.

## 2. Goal-oriented automated development

This stage was much more AI-native. Codex worked more like a very fast software development team, providing rapid prototyping based on goals and completion criteria that I specified. For example, I defined that the system should correctly determine whether a scheduled trip is represented in realtime data, and that the Ask harness should return correct evidence-grounded responses. Codex was also used heavily for automated testing, code review, debugging, and optimization.

## 3. Human testing and bug fixing

After the initial implementation, I tested the system myself and identified issues requiring more detailed judgment. For example, I found problems with GTFS-RT direction handling and corrected the expected behavior. I also provided new guidelines, more detailed design specifications, revised the prompts used by the LLM, changed feature scope, and ran experiments myself. At this stage, AI was mainly used at AI-assisting level.

## 4. System understanding and finalization

AI was finally used to help me understand implementation mechanisms that I did not fully understand, inspect possible issues, and suggest final stage refinements. I then used this understanding to fine-tune parts of the system and conduct further full-pipeline testing. The final documentation were also completed by myself.

## Notes

Codex was used throughout development and spans all the components of VIGO Agency with my knowledge on the entire architecture and core decisions. The GTFS-RT integration and Agency analysis layer were developed with heavy AI assistance.
This is the most feasible way for a single person to work on a 10K+ code lines major project in such a short pace.

Existing VIGO routing and GUI infrastructure were also developed in a similar AI-native style. This would otherwise take years to complete.

Ask uses a configurable function-calling model to interpret questions and select VIGO Agency tools. The harness was repeatedly tested and refined with the support of AI output based testing during development via a local **Qwen3.5-4B** model deployed through Ollama.
