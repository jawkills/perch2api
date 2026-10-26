# AGENTS.md — Perch2API

## Overview

OpenAI-compatible gateway in front of Perch (`perchai.app`) hosted-model inference. It reads a
logged-in Perch session file (Supabase JWT), calls the undocumented
`POST /api/perch-terminal/model-call` proxy, and re-emits the result as OpenAI chat completions.

- Stack: Node.js >= 22, ESM, **zero dependencies** (stdlib `http`, `fetch`, `crypto`).
- Runtime entry: `src/server.mjs`.
- Package manager: npm (only used for the `re/` reverse-engineering workspace, never for `src/`).

## Lane and persona

`PERCH_LANE` defaults to `code` on purpose. Perch enforces its Saffron operator prompt
server-side on the `chat` and `worker` lanes, so a caller cannot remove the persona there; on
`code` the caller's system prompt wins, and a neutral instruction is appended when the caller
sends none. Do not "clean up" the gate prefix: every lane requires it (verified against
`clientSurface` variants and minted turn tickets).

## Commands

```bash
node src/server.mjs                  # run the gateway (default http://127.0.0.1:8790)
node scripts/smoke.mjs               # end-to-end checks against a running instance
node probes/probe-vision.mjs         # vision wire-format matrix (needs a live session)
node probes/extract.cjs --out re --dump-sources   # rebuild the RE workspace
node scripts/login.mjs               # PKCE login -> cli-auth-session.json
node scripts/extract-prefix.mjs      # derive .perch-prefix.txt from a local Perch CLI
node scripts/login.mjs --dry-run --no-open   # print the OAuth URL without waiting
PORT=8800 node src/server.mjs        # alternate port
```

There is no build step, no test framework, and no linter. `scripts/smoke.mjs` is the gate.

## Conventions

- ESM only, `.mjs` extension, named exports, `async/await` over callbacks.
- Errors carry `{ status, code }` via `PerchError`; the server maps them to HTTP.
- All upstream field names stay in Perch's vocabulary (`roostModelChoice`, `preferredModelId`,
  `finishReason`, `answer_delta`) — do not "rename for cleanliness" in `gateway.mjs`; the
  translation layer is `openai.mjs` and that is the only place OpenAI names appear.
- Config is read once at import time from `process.env` in `src/config.mjs`. Add new knobs there,
  never inline in handlers.
- Constants measured from the wire (`src/perch-prefix.mjs`) carry a comment stating the
  observation, the bisect result, and the date.

Example:

```js
// src/gateway.mjs
const response = await fetch(`${baseUrl}/api/perch-terminal/model-call`, {
  headers: { 'x-perch-locale': config.locale, 'User-Agent': config.userAgent },
});
```

## Boundaries

**NEVER** touch or commit:

- `.env`, `.perch-prefix.txt`, `accounts/`, any `cli-auth-session.json` (live credentials, and
  the derived prefix which is Perch's text, not ours to publish).
- `re/cli/package/node_modules/`, `re/run1/`, `data/*.txt` — regenerable bulk.
- The extracted third-party source in `re/src-main/` is reference material: read it, never edit it.

Do not remove the `PERCH_SYSTEM_PREFIX` prepend or the `perchai-cli/` User-Agent without a live
re-test: both were isolated by differential probing (see `docs/RE-FINDINGS.md` §5) and the
server rejects requests without them.

## Dependencies

None at runtime. `re/` uses `js-beautify` and `npm` ad hoc; the CLI workspace under
`re/cli/package` has its own `package.json` (needed only to execute the real CLI for captures).

## Configuration

See `.env.example` and the table in `README.md`. Values are placeholders only — no secret ever
belongs in a file that is committed.

## Error handling

- Upstream plan refusals (403 `starter_model_blocked`, 429 `turn_rate_limited`,
  `perch_surface_required`) are **passed through** with the original message and `perch.limit`
  metadata. Do not rewrite them into generic 500s; they are the operator's signal.
- 401 triggers exactly one forced token refresh and a single replay of the identical body.
- 5xx / 408 / 425 retry up to `PERCH_MAX_RETRIES`, but only before any stream byte was forwarded.

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `no_session` on startup | No `cli-auth-session.json` found | `node scripts/login.mjs`, or set `PERCH_CLI_AUTH_DIR` |
| 403 `perch_surface_required` | System-prompt prefix dropped (`PERCH_SYSTEM_PREFIX_MODE=off`) | Restore `prepend` |
| 403 `starter_model_blocked` | Requested a Pro tier on a Starter/pilot plan | Use `perch` / `perch-standard-max` |
| 429 `turn_rate_limited` | Too many turn-ticket mints | The gateway never mints tickets; a 429 here means the plan quota, not ticketing |
| `refresh_failed` | Refresh token rotated elsewhere (CLI/Desktop logged in again) | Re-run `scripts/login.mjs` |
| Answers look like a different model than requested | Plan pool substitution | Read `perch.model` in the response; that is the truth |
