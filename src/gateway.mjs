/**
 * Perch model-call transport.
 *
 * Endpoint (OBSERVED): POST {appUrl}/api/perch-terminal/model-call
 * Headers: Authorization: Bearer <supabase access token>
 *          User-Agent: perchai-cli/<version>
 *          x-perch-locale: en
 *          Accept: text/event-stream
 *          x-perch-call-delta: 1        (optional: enables held-context deltas)
 * Body: { request: { messages, tools?, toolChoice?, maxTokens, temperature },
 *         runId, lane, strictManual, preferredModelId?, roostModelChoice?,
 *         attribution, clientSurface, avoidModelIds, resendAfterOutput }
 *
 * Response: text/event-stream of JSON events —
 *   {"type":"reasoning_delta","text":...}
 *   {"type":"answer_delta","text":...}
 *   {"type":"tool_call_delta","toolCalls":[...]}
 *   {"type":"stream_restart"} | {"type":"continuation_seam","at":n}
 *   {"type":"model_call_failed",...}
 *   {"type":"done","ok":true,"text","content","toolCalls","finishReason",
 *                  "provider","model","durationMs","usage":{...}}
 */
import { config } from './config.mjs';

export class PerchError extends Error {
  constructor(message, { status = 0, code = 'perch_error', limit = null } = {}) {
    super(message);
    this.name = 'PerchError';
    this.status = status;
    this.code = code;
    this.limit = limit;
  }
}

/** Build the upstream body from already-normalised messages + options. */
export function buildRequestBody({
  messages, tools, toolChoice, maxTokens, temperature, stop,
  model, runId, reasoning, attribution,
}) {
  const request = { messages };
  if (Array.isArray(tools) && tools.length) {
    request.tools = tools;
    request.toolChoice = toolChoice || 'auto';
  }
  if (Number.isFinite(maxTokens)) request.maxTokens = maxTokens;
  if (Number.isFinite(temperature)) request.temperature = temperature;
  if (Array.isArray(stop) && stop.length) request.stop = stop;

  const body = {
    request,
    runId,
    lane: config.lane,
    // OBSERVED (real CLI, `perch run --model qwen-3.8-max`, 2026-10-26): a manual
    // pin is expressed with THREE fields — preferredModelId, manualModelOptionId
    // (same value) and strictManual:false. Sending only preferredModelId (and/or
    // strictManual:true) makes the server fall back to the account default model
    // without erroring, which looks exactly like "pins are ignored".
    strictManual: false,
    clientSurface: config.clientSurface,
    attribution,
    avoidModelIds: [],
    resendAfterOutput: true,
  };
  if (model.kind === 'roost') body.roostModelChoice = model.roostModelChoice;
  if (model.kind === 'pin') {
    body.preferredModelId = model.preferredModelId;
    body.manualModelOptionId = model.preferredModelId;
  }
  if (reasoning) body.reasoning = reasoning;
  return body;
}

function parseSseChunk(buffer, onEvent) {
  const lines = buffer.split('\n');
  const rest = lines.pop() ?? '';
  for (const line of lines) {
    if (!line.startsWith('data:')) continue;
    const payload = line.slice(5).trim();
    if (!payload) continue;
    try {
      onEvent(JSON.parse(payload));
    } catch {
      /* keepalive or partial frame — ignore */
    }
  }
  return rest;
}

/**
 * Execute one model call and drive `onEvent` for every streamed frame.
 * Resolves with the terminal `done` frame (or throws PerchError).
 */
export async function callModel({
  baseUrl,
  token,
  body,
  signal,
  onEvent,
  onRetry,
}) {
  let attempt = 0;
  let lastError = null;

  for (;;) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(new Error('perch request timeout')), config.requestTimeoutMs);
    const onAbort = () => controller.abort(signal?.reason ?? new Error('client aborted'));
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }

    let sawEvent = false;
    try {
      const response = await fetch(`${baseUrl}/api/perch-terminal/model-call`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'text/event-stream',
          Authorization: `Bearer ${token}`,
          'User-Agent': config.userAgent,
          'x-perch-locale': config.locale,
          'x-perch-call-delta': '1',
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (!response.ok) {
        const raw = await response.text().catch(() => '');
        let payload = null;
        try { payload = JSON.parse(raw); } catch { /* non-JSON error page */ }
        const error = new PerchError(
          payload?.error || `Perch model-call failed: HTTP ${response.status}`,
          { status: response.status, code: payload?.errorCode || `http_${response.status}`, limit: payload?.limit ?? null },
        );
        // 401 = stale token: caller can refresh and retry once.
        if (response.status === 401) throw Object.assign(error, { retryable: false, auth: true });
        // 429 / 403 plan refusals are terminal.
        if (response.status === 429 || response.status === 403) throw Object.assign(error, { retryable: false });
        if (response.status >= 500 || response.status === 408 || response.status === 425) {
          throw Object.assign(error, { retryable: true });
        }
        throw error;
      }
      if (!response.body) throw new PerchError('Perch returned an empty body', { status: 502 });

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let done = null;

      try {
        for (;;) {
          const { value, done: eof } = await reader.read();
          if (eof) break;
          buffer += decoder.decode(value, { stream: true });
          buffer = parseSseChunk(buffer, (event) => {
            sawEvent = true;
            if (event.type === 'done') {
              done = event;
            } else {
              onEvent(event);
            }
          });
        }
        if (buffer.trim()) {
          parseSseChunk(`${buffer}\n`, (event) => {
            sawEvent = true;
            if (event.type === 'done') done = event;
            else onEvent(event);
          });
        }
      } finally {
        reader.cancel().catch(() => {});
        reader.releaseLock?.();
      }

      if (!done) {
        throw Object.assign(new PerchError('Perch stream ended without a done event', { status: 502, code: 'incomplete_stream' }),
          { retryable: !sawEvent });
      }
      if (done.ok === false) {
        throw new PerchError(done.error || 'Perch reported a failed model call',
          { status: 502, code: done.errorCode || 'model_call_failed', limit: done.limit ?? null });
      }
      return done;
    } catch (error) {
      lastError = error;
      const aborted = signal?.aborted;
      if (aborted) throw Object.assign(new PerchError('client aborted', { status: 499, code: 'client_aborted' }), { aborted: true });
      const retryable = error?.retryable === true || (error?.name === 'AbortError');
      if (!retryable || attempt >= config.maxRetries || sawEvent) throw normalizeError(error);
      attempt += 1;
      onRetry?.(attempt, error);
      await new Promise((resolve) => setTimeout(resolve, 500 * 2 ** (attempt - 1)));
    } finally {
      clearTimeout(timeout);
      if (signal) signal.removeEventListener('abort', onAbort);
    }
  }
}

function normalizeError(error) {
  if (error instanceof PerchError) return error;
  if (error?.name === 'AbortError' || /timeout|aborted/i.test(error?.message || '')) {
    return new PerchError('Perch request timed out', { status: 504, code: 'timeout' });
  }
  return new PerchError(error?.message || 'Perch request failed', { status: 502, code: 'transport_error' });
}

/** Plan / usage snapshot for the account behind a session. */
export async function fetchAccount({ baseUrl, token, signal }) {
  const res = await fetch(`${baseUrl}/api/perchai/account`, {
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${token}`,
      'User-Agent': config.userAgent,
      'x-perch-locale': config.locale,
    },
    signal: signal ?? AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new PerchError(`account HTTP ${res.status}`, { status: res.status, code: 'account_failed' });
  return res.json();
}
