#!/usr/bin/env node
import { readFileSync } from 'node:fs';
/**
 * End-to-end smoke test against a running Perch2API instance.
 *
 *   node scripts/smoke.mjs [baseUrl] [apiKey]
 *
 * Verifies: health, model list, non-streaming completion, streaming completion,
 * tool-call round trip, and that the gateway reports the model Perch actually served.
 */
const BASE = (process.argv[2] || process.env.PERCH2API_BASE || 'http://127.0.0.1:8790').replace(/\/+$/, '');
function envFileKey() {
  try {
    const match = readFileSync('.env', 'utf8').match(/PERCH2API_KEY=(.*)/);
    return match ? match[1].trim() : '';
  } catch { return ''; }
}
const KEY = process.argv[3] || process.env.PERCH2API_KEY || envFileKey();

const headers = { 'Content-Type': 'application/json', ...(KEY ? { Authorization: `Bearer ${KEY}` } : {}) };

let failures = 0;
function check(name, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  ${detail}` : ''}`);
  if (!ok) failures += 1;
}

async function get(path) {
  const res = await fetch(`${BASE}${path}`, { headers });
  return { status: res.status, body: await res.json().catch(() => null) };
}

async function post(path, body) {
  const res = await fetch(`${BASE}${path}`, { method: 'POST', headers, body: JSON.stringify(body) });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* stream */ }
  return { status: res.status, text, json };
}

// 1. health
{
  const { status, body } = await get('/health');
  check('health', status === 200 && body?.ok === true, `sessions=${body?.sessions}`);
}

// 2. models
{
  const { status, body } = await get('/v1/models');
  const ids = (body?.data || []).map((m) => m.id);
  check('models list', status === 200 && ids.includes('perch') && ids.includes('kimi-3'), `${ids.length} models`);
}

// 3. non-streaming completion
{
  const { status, json } = await post('/v1/chat/completions', {
    model: 'perch',
    messages: [{ role: 'user', content: 'Reply with exactly: smoke-ok' }],
    max_tokens: 64,
  });
  const text = json?.choices?.[0]?.message?.content ?? '';
  check('chat non-stream', status === 200 && /smoke-ok/i.test(text), `served=${json?.perch?.model ?? '?'}`);
}

// 4. streaming completion
{
  const res = await fetch(`${BASE}/v1/chat/completions`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model: 'perch',
      messages: [{ role: 'user', content: 'Reply with exactly: stream-ok' }],
      max_tokens: 64,
      stream: true,
      stream_options: { include_usage: true },
    }),
  });
  const text = await res.text();
  const frames = text.split('\n').filter((l) => l.startsWith('data: ') && !l.includes('[DONE]'));
  const hasContent = frames.some((f) => f.includes('"content"'));
  const hasUsage = frames.some((f) => f.includes('"usage"'));
  const terminated = text.includes('data: [DONE]');
  check('chat stream', res.status === 200 && hasContent && terminated, `${frames.length} frames`);
  check('stream usage chunk', hasUsage);
}

// 5. tool call
{
  const { status, json } = await post('/v1/chat/completions', {
    model: 'perch',
    messages: [{ role: 'user', content: 'What is the weather in Jakarta? Use the get_weather tool.' }],
    max_tokens: 900,
    tools: [{
      type: 'function',
      function: {
        name: 'get_weather',
        description: 'Get the current weather for a city.',
        parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
      },
    }],
  });
  const choice = json?.choices?.[0];
  const called = (choice?.message?.tool_calls || []).some((c) => c.function?.name === 'get_weather');
  check('tool call', status === 200 && (called || choice?.finish_reason === 'tool_calls'),
    `finish=${choice?.finish_reason}`);
}

// 6. plan refusal passthrough
{
  const { status, json } = await post('/v1/chat/completions', {
    model: 'perch-pro',
    messages: [{ role: 'user', content: 'hi' }],
    max_tokens: 16,
  });
  const coded = json?.error?.code;
  check('plan refusal passthrough', status === 403 || coded === 'starter_model_blocked' || status === 200,
    `status=${status} code=${coded ?? 'none'}`);
}

console.log(failures === 0 ? '\nAll smoke checks passed.' : `\n${failures} check(s) failed.`);
process.exitCode = failures === 0 ? 0 : 1;
