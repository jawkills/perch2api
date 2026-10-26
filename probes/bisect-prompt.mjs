#!/usr/bin/env node
/**
 * Bisect the system-prompt requirement of the perch_surface_required gate.
 * Every variant reuses one turn ticket.
 */
import fs from 'node:fs';
import path from 'node:path';

const APP = 'https://app.perchai.app';
const UA = `perchai-cli/${process.env.PERCH_CLI_VERSION || '2.4.118'}`;
const session = JSON.parse(fs.readFileSync(
  path.join(process.env.APPDATA, 'Perch AI Desktop', 'cli-auth-session.json'), 'utf8'));
const auth = {
  Authorization: `Bearer ${session.accessToken}`,
  'User-Agent': UA,
  'x-perch-locale': 'en',
};

const captureDir = 're/run1/capture';
const capFile = fs.readdirSync(captureDir).find((f) => f.startsWith('008_'));
const realBody = JSON.parse(JSON.parse(fs.readFileSync(path.join(captureDir, capFile), 'utf8')).body);
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
    if (j.errorCode === 'turn_rate_limited') {
      await new Promise((res) => setTimeout(res, 15000 * (i + 1)));
      continue;
    }
    throw new Error(JSON.stringify(j));
  }
  throw new Error('could not mint ticket');
}

const ticket = await mint();
console.log('ticket ok', ticket.runId);

async function call(name, systemContent, userContent = 'Say pong and nothing else.') {
  const body = {
    request: {
      messages: [
        ...(systemContent === null ? [] : [{ role: 'system', content: systemContent }]),
        { role: 'user', content: userContent },
      ],
      maxTokens: 24,
    },
    runId: ticket.runId,
    lane: 'chat',
    strictManual: false,
    clientSurface: 'cli',
    attribution: realBody.attribution,
    preferredModelId: realBody.preferredModelId,
    avoidModelIds: realBody.avoidModelIds,
    resendAfterOutput: true,
  };
  const r = await fetch(`${APP}/api/perch-terminal/model-call`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
      ...auth,
      'x-perch-turn-ticket': ticket.ticket,
      'x-perch-call-delta': '1',
    },
    body: JSON.stringify(body),
  });
  const text = await r.text();
  const ok = r.status === 200 && /"type":"done"/.test(text);
  const model = /"model":"([^"]+)"/.exec(text)?.[1] ?? '-';
  console.log(`[${name}] HTTP ${r.status}${ok ? ' PASS' : ''} model=${model} :: ${ok ? '' : text.slice(0, 90).replace(/\s+/g, ' ')}`);
  return ok;
}

// isolation: full system prompt + our own user message
const r1 = await call('full+otherUser', realSystem);

// prefix ladder
for (const L of [20000, 8000, 3000, 1200, 600, 300, 150, 80]) {
  await call(`prefix-${L}`, realSystem.slice(0, L));
  await new Promise((r) => setTimeout(r, 1200));
}
