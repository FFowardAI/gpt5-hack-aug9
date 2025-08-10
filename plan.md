# GPT-5 x Maestro: Visual QA Engineer-in-the-Loop

This plan outlines a working system that lets non-coders generate, run, and iterate UI gen across web using Maestro, GPT-5, cursor, and a lightweight “Studio-like” reviewer. It also covers video/voice extensions, artifacting, PR reporting, and CI.

## Goals (mapped to judging)
- **GPT‑5 in Development (25%)**: GPT‑5 generates/updates tests, summarizes failures, proactively proposes surgical code edits.
- **GPT‑5 in Project (25%)**: GPT‑5 runs at runtime to interpret screenshots sequence and produce structured actions/reports that are integrated into cursor workflow through the MCP server.
- **Live Demo (25%)**: Ask for a UI change → auto test generation → run → diff → if not as expected generate new changes -> after completion PR with images and repro steps.
- **Technicality (25%)**: Efficient frame budget, selector stability, artifact pipeline, MCP server, screenshots, safe PRs.

## System overview
- User (non‑coder) interacts with cursor to develop code.
- After alteration, cursor calls our MCP.
- Our MCP calls GPT-5 that converts natural language + HTML code into a test flow, compiled to Maestro YAML.
- Runner executes Maestro flows on desktop web; captures multiple screenshots and send them to GPT-5 for confirmation as well..
- Compares to baselines; GPT‑5 summarizes visual deltas and output if the changes were completed.
- Reporter writes `report.md` with images, traces, links; CI posts it to PRs. Artifacts/baselines are versioned in repo.


The idea is that non-coders can iterate fast on frontend development without needing a human in the loop as gpt-5 can check the code and the UI after each call and suggest new alterations if needed.