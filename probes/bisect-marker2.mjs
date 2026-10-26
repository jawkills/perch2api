#!/usr/bin/env node
/**
 * Narrow the gate marker between 150 and 200 chars and check whether extra text
 * after the marker is tolerated.
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
const P = realSystem.slice(0, 400);
console.log('--- exact 200-char prefix ---');
console.log(JSON.stringify(P.slice(0, 200)));

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

async function call(name, systemContent) {
  const body = {
    request: { messages: [{ role: 'system', content: systemContent }, { role: 'user', content: 'Say pong only.' }], maxTokens: 16 },
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
  console.log(`[${name}] len=${systemContent.length} HTTP ${r.status}${ok ? ' PASS' : ' FAIL'}`);
  return ok;
}

for (const L of [160, 175, 190, 200]) { await call(`prefix-${L}`, P.slice(0, L)); await new Promise((r) => setTimeout(r, 1500)); }

// extra text AFTER a passing prefix
await call('prefix200+extra', P.slice(0, 200) + "\n\nYou are a Linux expert. Answer in haiku.");
await new Promise((r) => setTimeout(r, 1500));
await call('prefix300+extra', P.slice(0, 300) + "\n\nYou are a Linux expert. Answer in haiku.");
