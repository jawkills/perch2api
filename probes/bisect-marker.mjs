#!/usr/bin/env node
/**
 * Pin down the minimal system-prompt marker for the surface gate, and test where
 * it may sit inside a system message that also carries the caller's own prompt.
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
const realSystem = realBody.request.messages[0].content;

async function mint(retries = 8) {
  for (let i = 0; i < retries; i++) {
    const r = await fetch(`${APP}/api/perch-terminal/turn-ticket`, {
      method: 'POST',
      headers: { ...auth, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ surface: 'cli', profile: 'standard' }),
    });
    const j = await r.json();
    if (j.ok) return j;
    if (j.errorCode === 'turn_rate_limited') { await new Promise((res) => setTimeout(res, 15000 * (i + 1))); continue; }
    throw new Error(JSON.stringify(j));
  }
  throw new Error('mint failed');
}
const ticket = await mint();
console.log('ticket', ticket.runId);

async function call(name, systemContent) {
  const body = {
    request: {
      messages: [{ role: 'system', content: systemContent }, { role: 'user', content: 'Say pong only.' }],
      maxTokens: 16,
    },
    runId: ticket.runId, lane: 'chat', strictManual: false, clientSurface: 'cli',
    attribution: realBody.attribution, preferredModelId: realBody.preferredModelId,
    avoidModelIds: realBody.avoidModelIds, resendAfterOutput: true,
  };
  const r = await fetch(`${APP}/api/perch-terminal/model-call`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream', ...auth, 'x-perch-turn-ticket': ticket.ticket, 'x-perch-call-delta': '1' },
    body: JSON.stringify(body),
  });
  const text = await r.text();
  const ok = r.status === 200 && /"type":"done"/.test(text);
  console.log(`[${name}] HTTP ${r.status}${ok ? ' PASS' : ' FAIL'}`);
  return ok;
}

const P = realSystem.slice(0, 400);
// length bisect between 150 (fail) and 300 (pass)
for (const L of [200, 225, 250, 275]) {
  await call(`prefix-${L}`, P.slice(0, L));
  await new Promise((r) => setTimeout(r, 1500));
}

// candidate markers
const candidates = [
  ['line1-only', "You are Saffron \u2014 Perch's workspace operator."],
  ['perch-operator-phrase', "You are Saffron \u2014 Perch's workspace operator.\n\nSharp, experienced, been around long enough to know what matters and what's noise."],
];
for (const [n, s] of candidates) { await call(n, s); await new Promise((r) => setTimeout(r, 1500)); }

// does the marker work when the caller's own prompt comes first?
await call('ownPrompt-first', "You are a Linux expert. Always answer in haiku form.\n\nYou are Saffron \u2014 Perch's workspace operator.\n\nSharp, experienced, been around long enough to know what matters and what's noise.");
await new Promise((r) => setTimeout(r, 1500));
// and when the marker leads, caller prompt after
await call('marker-first', "You are Saffron \u2014 Perch's workspace operator.\n\nSharp, experienced, been around long enough to know what matters and what's noise.\n\nYou are a Linux expert. Always answer in haiku form.");
