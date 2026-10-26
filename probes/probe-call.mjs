#!/usr/bin/env node
/**
 * Live contract probe for POST /api/perch-terminal/model-call.
 * Mints a turn ticket, sends a minimal request, records the SSE stream.
 * Usage: node probe-call.mjs [mode] [modelOrTier]
 *   mode: bare | roost | pin | nostream
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const APP = 'https://app.perchai.app';
const UA = `perchai-cli/${process.env.PERCH_CLI_VERSION || '2.4.118'}`;
const session = JSON.parse(fs.readFileSync(
  path.join(process.env.APPDATA, 'Perch AI Desktop', 'cli-auth-session.json'), 'utf8'));

const mode = process.argv[2] || 'bare';
const arg = process.argv[3] || null;

async function mint() {
  const r = await fetch(`${APP}/api/perch-terminal/turn-ticket`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      Authorization: `Bearer ${session.accessToken}`,
      'User-Agent': UA,
      'x-perch-locale': 'en',
    },
    body: JSON.stringify({ surface: 'cli', profile: 'standard' }),
  });
  const j = await r.json();
  if (!j.ok) throw new Error('ticket failed: ' + JSON.stringify(j));
  return j;
}

const body = {
  request: {
    messages: [
      { role: 'system', content: 'You are a terse test assistant. Answer in one short sentence.' },
      { role: 'user', content: 'What is 2+2? Answer with just the number.' },
    ],
    maxTokens: 32,
    temperature: 0,
  },
  lane: 'chat',
  strictManual: false,
  clientSurface: 'cli',
  attribution: { userId: session.userId, source: 'cli' },
};

if (mode === 'roost') {
  body.roostModelChoice = arg || 'standard';
  body.roostReasoning = false;
} else if (mode === 'pin') {
  body.preferredModelId = arg;
} else if (mode === 'bare') {
  // nothing extra: server applies the account default
}

const ticket = await mint();
const headers = {
  'Content-Type': 'application/json',
  Accept: mode === 'nostream' ? 'application/json' : 'text/event-stream',
  Authorization: `Bearer ${session.accessToken}`,
  'User-Agent': UA,
  'x-perch-locale': 'en',
  'x-perch-turn-ticket': ticket.ticket,
};
if (mode !== 'nostream') headers['x-perch-call-delta'] = '1';

const t0 = Date.now();
const res = await fetch(`${APP}/api/perch-terminal/model-call`, {
  method: 'POST', headers, body: JSON.stringify(body),
});
console.log('HTTP', res.status, res.headers.get('content-type'), `(${Date.now() - t0}ms)`);
const text = await res.text();
console.log('--- BODY ---');
console.log(text.slice(0, 4000));
fs.writeFileSync(`data/probe-call-${mode}-${arg || 'default'}.txt`, text);
