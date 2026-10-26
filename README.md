# Perch2API

An OpenAI-compatible HTTP gateway in front of **Perch** (`perchai.app`) hosted-model
inference. Point any OpenAI client, SDK, or router (9Router, LiteLLM, one-api, Cartethyia,
OpenWebUI, …) at it and use the Perch account's model access over `/v1/chat/completions`.

No dependencies. Node 22+. ~900 lines total.

```
client ──► Perch2API :8790 ──► https://app.perchai.app/api/perch-terminal/model-call
              │                        │
              │  OpenAI SSE            │  Perch SSE
              └────────────────────────┘
```

> Unofficial, unaffiliated with Perch. It drives your own logged-in account against
> `app.perchai.app`; what you do with that account is your decision and your risk.

## Why this works (short version)

The Perch desktop app is a thin Electron shell around `https://app.perchai.app`; the real
runtime (agent loop + `model-call` client) ships in both the app's `dist-electron/main.js`
and the `perchai-cli` npm package. Reversing that transport gives exactly one call worth
wrapping:

```
POST https://app.perchai.app/api/perch-terminal/model-call
Authorization: Bearer <supabase access token from cli-auth-session.json>
User-Agent: perchai-cli/<version>
x-perch-locale: en
Accept: text/event-stream

{ "request": { "messages": [...], "tools": [...], "maxTokens": 64 },
  "runId": "...", "lane": "chat", "clientSurface": "cli",
  "roostModelChoice": "standard" | "standard_max" | "pro" | "pro_max",
  "preferredModelId": "<registry option id>", "strictManual": true,
  "attribution": { "userId": "...", "source": "cli", ... } }
```

Stream frames: `reasoning_delta`, `answer_delta`, `tool_call_delta`, `tool_use_end`,
`stream_restart`, `done` (carries `text`, `toolCalls`, `finishReason`, `model`, `usage`).

The full contract, the surface gate, and the plan limits are documented in
[`docs/RE-FINDINGS.md`](docs/RE-FINDINGS.md).

## Quick start

```bash
cd D:/Hermes-Project/perch2api
cp .env.example .env          # optional; every value has a default
node src/server.mjs           # http://127.0.0.1:8790
```

The gateway auto-discovers a logged-in Perch session from, in order:

1. `$PERCH_CLI_AUTH_DIR/cli-auth-session.json`
2. `~/.perch/cli-auth-session.json` (where `perchai-cli` stores it)
3. `%APPDATA%/Perch AI Desktop/cli-auth-session.json` (written by the Desktop app)

If none exists, log in with the same OAuth flow the CLI uses:

```bash
node scripts/login.mjs                       # Google/GitHub PKCE, writes the session file
node scripts/login.mjs --out accounts/acc2.json   # extra account for rotation
```

Verify:

```bash
node scripts/smoke.mjs
```

## API

| Route | Purpose |
|---|---|
| `POST /v1/chat/completions` | OpenAI chat completions (streaming + non-streaming, tools supported) |
| `GET /v1/models` | Roost tiers + named model pins |
| `GET /v1/account` | plan, entitlements, usage meter, limits for the active session |
| `GET /v1/sessions` | discovered session files, expiry, in-flight count |
| `GET /health` | liveness, session count, upstream URL |

Auth: set `PERCH2API_KEY` and send `Authorization: Bearer <key>`. Leave it empty for
loopback-only use.

```bash
curl -s http://127.0.0.1:8790/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"perch","messages":[{"role":"user","content":"halo"}],"stream":true}'
```

## Model names

Three ways to address a model:

| Form | Example | Behaviour |
|---|---|---|
| Roost tier | `perch`, `perch-standard-max`, `perch-pro`, `perch-pro-max` | Perch resolves the tier to whatever model the plan allows. Always valid. |
| Named pin | `kimi-3`, `deepseek-v4.1-flash-1017`, `claude-opus-5.5`, `gpt-6.1-sol` | Resolved to a registry option id and sent as `preferredModelId` + `strictManual`. |
| Raw option id | `wandb-kimi-k2-6` | Passed through verbatim as `preferredModelId`. |

Pins are **real**: `preferredModelId` + `manualModelOptionId` + `strictManual: false` selects the
model, and `qwen-3.8-max` is currently free on Starter, so it serves `Qwen/Qwen3.8-Max`. Models
outside the plan's pool fall back to the account default instead of erroring — check `perch.model`
(the model actually served) and `perch.substituted` to see it:

```json
"perch": { "model": "Qwen/Qwen3.8-Max", "requested": "qwen-3.8-max", "substituted": false, "duration_ms": 1189 }
```

`GET /v1/models` returns 49 entries: 4 tiers + 45 named pins.

## Persona and lanes

Perch attaches its own "You are Saffron - Perch's workspace operator" system prompt on the
`chat` and `worker` lanes, and the caller cannot override it (asking the model to drop the
persona gets refused). The `code` lane does not get it, so the gateway defaults to
`PERCH_LANE=code`: there the only persona is the 361-character gate prefix, and the caller's
system prompt wins. When a request arrives with no system prompt at all, the gateway appends a
neutral instruction after the prefix so the model does not fall back to Saffron.

Set `PERCH_LANE=chat` for Perch's full operator behaviour (persona included).

## Vision

Image parts pass straight through in OpenAI shape — `{"type":"image_url","image_url":{"url":"data:image/png;base64,..."}}` — and the model reads them (verified: 64x64 solid red PNG -> "Red" from `Qwen/Qwen3.8-Max`). Works on the default `code` lane, so no persona is attached. A top-level `images[]` array is ignored by the server; only message parts are read. `lane: vision` routes to a different model (`kimi-k2-5`) that returns no assistant text, so it is not used.

## Configuration

| Env | Default | Meaning |
|---|---|---|
| `PORT` / `HOST` | `8790` / `127.0.0.1` | Listen address |
| `PERCH2API_KEY` | *(empty)* | Bearer key required from clients |
| `PERCH_APP_URL` | `https://app.perchai.app` | Upstream app origin |
| `PERCH_CLI_AUTH_DIR` | *(unset)* | Directory containing `cli-auth-session.json` |
| `PERCH_SESSION_FILES` | *(unset)* | Comma-separated extra session files for rotation |
| `PERCH_CLI_VERSION` | `2.4.118` | Version stamped into the `perchai-cli/` User-Agent |
| `PERCH_LOCALE` | `en` | `x-perch-locale` header (error text language) |
| `PERCH_SYSTEM_PREFIX_MODE` | `prepend` | `prepend` = gate prefix + caller prompt; `off` = send the prompt as-is (will be refused upstream) |
| `PERCH_TIMEOUT_MS` | `180000` | Upstream request timeout |
| `PERCH_MAX_RETRIES` | `2` | Retries for 5xx / timeouts before the first byte |
| `PERCH_EXPOSE_REASONING` | `true` | Emit Perch reasoning deltas as `delta.reasoning_content` |
| `PERCH_DISABLE_THINKING` | `false` | Force `reasoning: { enableThinking: false }` upstream |
| `PERCH2API_LOG` | `true` | Per-request logging |
| `PERCH_LANE` | `code` | Upstream lane: `code` (persona-free) or `chat` (Perch operator) |
| `PERCH_NEUTRAL_SYSTEM` | built in | Instruction appended after the prefix when the caller sends no system prompt |

## Multi-account

Every session file is a slot. The gateway pins a request to the least-busy slot, refreshes
the Supabase token per slot (persisting the rotated refresh token back to the file), and
never shares state between slots.

```bash
node scripts/login.mjs --out accounts/acc1.json
node scripts/login.mjs --out accounts/acc2.json
PERCH_SESSION_FILES=accounts/acc1.json,accounts/acc2.json node src/server.mjs
```

## 9Router / Cartethyia

9Router → **Providers → Add Provider → OpenAI Compatible**:

| Field | Value |
|---|---|
| Base URL | `http://127.0.0.1:8790/v1` |
| API Key | your `PERCH2API_KEY` (or any string when unset) |
| Models | `perch`, `perch-standard-max`, `perch-pro`, `kimi-3`, … |

Any tool that speaks the OpenAI Chat Completions API works the same way — the gateway is
plain HTTP with no vendor headers.

## Limits you inherit from Perch

- **Plan-bound models.** Starter/"pilot" accounts get Roost Standard + Standard Max only.
  `perch-pro` returns HTTP 403 `starter_model_blocked` with the upgrade text (passed through
  verbatim, including `perch.limit`).
- **PT quota.** Inference is metered in Perch credits (`1 PT = $0.001`). `GET /v1/account`
  shows the meter.
- **Surface gate.** Upstream refuses requests that do not look like a Perch turn. The
  gateway satisfies it by prepending Perch's 361-character system-prompt preamble unless the
  caller already starts their system message with it.
- **No turn tickets needed.** `x-perch-turn-ticket` is optional for this endpoint; the
  gateway deliberately skips minting, which also dodges the ticket rate limit.

## Layout

```
perch2api/
├── src/
│   ├── server.mjs          HTTP server, routing, chat handlers
│   ├── gateway.mjs         Perch model-call transport + SSE parser
│   ├── openai.mjs          OpenAI <-> Perch translation
│   ├── session.mjs         session discovery, refresh, rotation
│   ├── models.mjs          tier + pin resolution, /v1/models payload
│   ├── perch-prefix.mjs    the system-prompt gate prefix (measured constant)
│   ├── config.mjs          env configuration
│   └── model-aliases.json  alias -> registry option id table
├── scripts/
│   ├── login.mjs           PKCE login, writes cli-auth-session.json
│   └── smoke.mjs           end-to-end checks against a running instance
├── docs/RE-FINDINGS.md     reverse-engineering report (observed/inferred/unknown)
└── re/                     the artifacts the findings came from
```

## Status

Working end to end against a live account (2026-10-26): non-streaming, streaming,
tool calls, plan-refusal passthrough, token refresh. `scripts/smoke.mjs` is the gate.
