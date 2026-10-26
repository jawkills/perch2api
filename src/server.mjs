#!/usr/bin/env node
/**
 * Perch2API — OpenAI-compatible gateway in front of the Perch (perchai.app)
 * hosted model proxy.
 *
 *   POST /v1/chat/completions   streaming + non-streaming
 *   GET  /v1/models             Roost tiers and named pins
 *   GET  /v1/account            plan, entitlements, usage meter for the session
 *   GET  /v1/sessions           discovered session files and their state
 *   GET  /health
 */
import http from 'node:http';
import { config } from './config.mjs';
import { SessionStore } from './session.mjs';
import { buildRequestBody, callModel, fetchAccount, PerchError } from './gateway.mjs';
import { resolveModel, listModels } from './models.mjs';
import {
  newCompletionId, normalizeMessages, collectCompletion, pipeAsOpenAIStream, openAIError,
} from './openai.mjs';

const store = SessionStore.discover();
const loaded = await store.reload();

function log(...args) {
  if (config.logRequests) console.log(new Date().toISOString(), ...args);
}

function authorize(req) {
  if (!config.apiKey) return true;
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : (req.headers['x-api-key'] || '');
  return token === config.apiKey;
}

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
}

async function readJson(req, limitBytes = 32 * 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limitBytes) throw new PerchError('request body too large', { status: 413, code: 'payload_too_large' });
    chunks.push(chunk);
  }
  if (!size) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function attributionFor(slot, runId) {
  const session = slot.session ?? {};
  return {
    userId: session.userId ?? null,
    workspaceId: process.env.PERCH_WORKSPACE_ID || null,
    runId,
    lane: 'chat',
    source: 'cli',
    billingMultiplier: null,
  };
}

function statusForPerchError(error) {
  if (error?.status === 401) return 401;
  if (error?.status === 403) return 403;
  if (error?.status === 404) return 404;
  if (error?.status === 429) return 429;
  if (error?.status === 499) return 499;
  if (error?.status >= 400 && error?.status < 600) return error.status;
  return 502;
}

/**
 * Run one model call with a per-account retry on 401 (stale access token).
 * Refreshes the token once, then re-issues the identical body.
 */
async function runModelCall({ model, messages, tools, options, signal, onEvent }) {
  const { slot, release } = store.pick();
  try {
    const runId = `p2api-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const body = buildRequestBody({
      messages,
      tools,
      toolChoice: options.toolChoice,
      maxTokens: options.maxTokens,
      temperature: options.temperature,
      stop: options.stop,
      model,
      runId,
      reasoning: options.reasoning,
      attribution: attributionFor(slot, runId),
    });

    const call = async (cb) => {
      let token = await store.token(slot);
      try {
        return await callModel({
          baseUrl: slot.session.appUrl || config.appUrl,
          token,
          body,
          signal,
          onEvent: cb.onEvent,
          onRetry: (attempt, error) => log(`retry ${attempt} for ${runId}: ${error.message}`),
        });
      } catch (error) {
        if (error?.auth) {
          token = await store.token(slot, { force: true });
          return callModel({
            baseUrl: slot.session.appUrl || config.appUrl,
            token,
            body,
            signal,
            onEvent: cb.onEvent,
          });
        }
        throw error;
      }
    };

    return await onEvent(call);
  } finally {
    release();
  }
}

function normalizeOptions(body) {
  const maxTokens = body.max_completion_tokens ?? body.max_tokens;
  const reasoningEffort = body.reasoning_effort;
  const reasoning = config.disableThinkingByDefault || reasoningEffort === 'none'
    ? { enableThinking: false }
    : undefined;
  return {
    maxTokens: Number.isFinite(maxTokens) ? Math.max(1, Math.min(maxTokens, 32_000)) : undefined,
    temperature: Number.isFinite(body.temperature) ? body.temperature : undefined,
    stop: body.stop,
    toolChoice: body.tool_choice,
    reasoning,
  };
}

const server = http.createServer(async (req, res) => {
  cors(res);
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const route = url.pathname.replace(/\/+$/, '') || '/';

  if (route === '/health' || route === '/') {
    const body = JSON.stringify({
      ok: true,
      service: 'perch2api',
      version: '1.0.0',
      sessions: store.size,
      loaded,
      upstream: config.appUrl,
    });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(body);
    return;
  }

  if (!authorize(req)) {
    openAIError(res, 401, 'Invalid API key', { code: 'invalid_api_key', type: 'authentication_error' });
    return;
  }

  try {
    if (req.method === 'GET' && (route === '/v1/models' || route === '/models')) {
      const body = JSON.stringify({
        object: 'list',
        data: listModels(),
      });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(body);
      return;
    }

    if (req.method === 'GET' && route === '/v1/sessions') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ object: 'list', data: store.describe() }));
      return;
    }

    if (req.method === 'GET' && (route === '/v1/account' || route === '/account')) {
      const { slot, release } = store.pick();
      try {
        const token = await store.token(slot);
        const account = await fetchAccount({ baseUrl: slot.session.appUrl || config.appUrl, token });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(account));
      } finally {
        release();
      }
      return;
    }

    if (req.method === 'POST' && (route === '/v1/chat/completions' || route === '/chat/completions')) {
      const body = await readJson(req);
      if (!Array.isArray(body.messages) || !body.messages.length) {
        openAIError(res, 400, 'messages must be a non-empty array', { code: 'invalid_messages' });
        return;
      }

      const model = resolveModel(body.model);
      const messages = normalizeMessages(body.messages);
      const tools = Array.isArray(body.tools) ? body.tools : null;
      const options = normalizeOptions(body);
      const stream = body.stream === true;
      const includeUsage = Boolean(body.stream_options?.include_usage);
      const id = newCompletionId();
      const created = Math.floor(Date.now() / 1000);
      const controller = new AbortController();
      req.on('close', () => controller.abort());

      log(`chat model=${model.requested} kind=${model.kind} stream=${stream} messages=${messages.length} tools=${tools?.length ?? 0}`);

      if (stream) {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache, no-transform',
          Connection: 'keep-alive',
        });
        try {
          const done = await runModelCall({
            model, messages, tools, options, signal: controller.signal,
            onEvent: (call) => pipeAsOpenAIStream({
              res,
              id,
              created,
              modelName: model.requested,
              includeUsage,
              call,
            }),
          });
          log(`done model=${model.requested} served=${done.model} tokens=${done.usage?.totalTokens ?? '?'}`);
        } catch (error) {
          if (res.writableEnded) return;
          const perchError = error instanceof PerchError ? error : new PerchError(error.message);
          res.write(`data: ${JSON.stringify({
            error: {
              message: perchError.message,
              type: 'perch_error',
              code: perchError.code,
              ...(perchError.limit ? { perch_limit: perchError.limit } : {}),
            },
          })}\n\n`);
          res.write('data: [DONE]\n\n');
          res.end();
          log(`stream error: ${perchError.code} ${perchError.message}`);
        }
        return;
      }

      const completion = await runModelCall({
        model, messages, tools, options, signal: controller.signal,
        onEvent: (call) => collectCompletion({ id, created, modelName: model.requested, expectedModelId: model.preferredModelId ?? null, call }),
      });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(completion));
      log(`done model=${model.requested} served=${completion.perch?.model} tokens=${completion.usage?.total_tokens ?? '?'}`);
      return;
    }

    openAIError(res, 404, `Unknown route ${route}`, { code: 'not_found' });
  } catch (error) {
    const status = statusForPerchError(error);
    const perchError = error instanceof PerchError ? error : new PerchError(error.message || 'internal error', { code: 'internal_error' });
    log(`error ${status} ${perchError.code}: ${perchError.message}`);
    if (!res.headersSent) {
      openAIError(res, status, perchError.message, {
        code: perchError.code,
        extra: perchError.limit ? { limit: perchError.limit } : null,
      });
    } else if (!res.writableEnded) {
      res.end();
    }
  }
});

server.listen(config.port, config.host, () => {
  console.log(`perch2api listening on http://${config.host}:${config.port}`);
  console.log(`  sessions discovered: ${store.size} (loaded ${loaded})`);
  for (const slot of store.describe()) {
    console.log(`   ${slot.ok ? 'OK ' : 'ERR'} ${slot.email || '-'}  ${slot.file}${slot.error ? `  (${slot.error})` : ''}`);
  }
  if (!config.apiKey) console.log('  auth: DISABLED (set PERCH2API_KEY to require a bearer key)');
  console.log(`  upstream: ${config.appUrl}  UA: ${config.userAgent}`);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    console.log(`\n${signal} received, shutting down`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 4000).unref();
  });
}
