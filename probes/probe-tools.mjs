#!/usr/bin/env node
/**
 * Tool-calling fidelity probe: does the model-call endpoint accept arbitrary
 * OpenAI-style tool definitions, emit tool calls on the SSE stream, and accept a
 * tool-result follow-up turn?
 */
import fs from 'node:fs';
import path from 'node:path';

const APP = 'https://app.perchai.app';
const UA = `perchai-cli/${process.env.PERCH_CLI_VERSION || '2.4.118'}`;
const session = JSON.parse(fs.readFileSync(
  path.join(process.env.APPDATA, 'Perch AI Desktop', 'cli-auth-session.json'), 'utf8'));
const auth = { Authorization: `Bearer ${session.accessToken}`, 'User-Agent': UA, 'x-perch-locale': 'en' };

const capFile = fs.readdirSync('re/run1/capture').find((f) => f.startsWith('008_'));
const realBody = JSON.parse(JSON.parse(fs.readFileSync(path.join('re/run1/capture', capFile), 'utf8')).body);
const PREFIX = realBody.request.messages[0].content.slice(0, 400);

const tools = [{
  type: 'function',
  function: {
    name: 'get_weather',
    description: 'Get the current weather for a city.',
    parameters: {
      type: 'object',
      properties: { city: { type: 'string', description: 'City name' } },
      required: ['city'],
      additionalProperties: false,
    },
  },
}];

async function call(name, requestBody, { stream = true } = {}) {
  const body = {
    request: requestBody,
    runId: 'gw-' + Date.now(),
    lane: 'chat',
    strictManual: false,
    clientSurface: 'cli',
    attribution: { ...realBody.attribution, runId: 'gw-' + Date.now() },
    avoidModelIds: [],
    resendAfterOutput: true,
  };
  const headers = { 'Content-Type': 'application/json', ...auth };
  if (stream) { headers.Accept = 'text/event-stream'; headers['x-perch-call-delta'] = '1'; }
  else headers.Accept = 'application/json';
  const r = await fetch(`${APP}/api/perch-terminal/model-call`, { method: 'POST', headers, body: JSON.stringify(body) });
  const text = await r.text();
  fs.writeFileSync(`data/tools-${name}.txt`, text);
  console.log(`\n[${name}] HTTP ${r.status} ctype=${r.headers.get('content-type')}`);
  console.log(text.slice(0, 1400));
  return text;
}

// 1. tools + forced-ish prompt
await call('stream-1', {
  messages: [{ role: 'system', content: PREFIX }, { role: 'user', content: 'What is the weather in Jakarta? Use the get_weather tool.' }],
  tools, toolChoice: 'auto', maxTokens: 200,
});

// 2. non-streaming
await call('nostream', {
  messages: [{ role: 'system', content: PREFIX }, { role: 'user', content: 'Say pong only.' }],
  maxTokens: 20,
}, { stream: false });

// 3. follow-up turn carrying an assistant tool_call + tool result
await call('stream-2-followup', {
  messages: [
    { role: 'system', content: PREFIX },
    { role: 'user', content: 'What is the weather in Jakarta? Use the get_weather tool.' },
    {
      role: 'assistant',
      content: '',
      tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'get_weather', arguments: '{"city":"Jakarta"}' } }],
    },
    { role: 'tool', tool_call_id: 'call_1', content: '{"tempC":31,"sky":"hazy"}' },
  ],
  tools, toolChoice: 'auto', maxTokens: 200,
});
