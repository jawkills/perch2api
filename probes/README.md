# Probes

The scripts that produced every OBSERVED claim in `docs/RE-FINDINGS.md`. They are kept for
reproduction, not as a supported API: each one is a one-off experiment against a live account.

All of them read a logged-in session from `%APPDATA%/Perch AI Desktop/cli-auth-session.json`,
`~/.perch/cli-auth-session.json`, or `$PERCH_CLI_AUTH_DIR`, and print raw results. None of them
mint a turn ticket unless named that way, and none spend more than a handful of tokens per call.

| Script | What it establishes |
|---|---|
| `extract.cjs` | asar reader + TypeScript recovery from `main.js.map` (the 3-byte offset trap) |
| `parse-aliases.mjs` | model alias -> registry option id table from the CLI bundle |
| `cli-hook.mjs` | fetch interceptor: captures real CLI traffic without a TLS proxy |
| `probe-read.mjs` / `probe-select.mjs` | read-only session/config probing; tiers, pins, ticket necessity |
| `probe-call.mjs` / `probe-gate.mjs` / `replay-matrix.mjs` | the `perch_surface_required` differential |
| `bisect-prompt.mjs` / `bisect-marker.mjs` / `bisect-marker2.mjs` | narrows the required prefix (190 fails, 200 passes) |
| `probe-tools.mjs` | tool definitions, tool-result follow-up turn, non-streaming |
| `probe-qwen.mjs` / `probe-force.mjs` | model pin fields (`manualModelOptionId`) and silent substitution |
| `probe-gate2.mjs` / `probe-ticket-gate.mjs` / `probe-lane-gate.mjs` | what the gate is NOT keyed on (surface, ticket, lane) |
| `probe-persona.mjs` | the Saffron persona is server-enforced on chat/worker, absent on code |
| `probe-vision.mjs` | vision wire format, data-URL acceptance, lane behaviour |
| `probe-plan-models.mjs` | plan payload, entitlements, usage meter |

Order matters when reading the findings: the gate had to be solved before anything else could be
measured, because a refused request returns no model information at all.
