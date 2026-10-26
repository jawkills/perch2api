#!/usr/bin/env node
/**
 * Replay matrix for the "perch_surface_required" gate.
 * One turn ticket is reused for every variant, because the rate limit applies to
 * ticket minting, not to model calls.
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

const captureDir = process.argv[2] || 're/run1/capture';
const capFile = fs.readdirSync(captureDir).find((f) => f.startsWith('008_'));
const captured = JSON.parse(fs.readFileSync(path.join(captureDir, capFile), 'utf8'));
const realBody = JSON.parse(captured.body);
console.log('control body: messages=%d tools=%d keys=%s',
  realBody.request.messages.length, realBody.request.tools?.length ?? 0, Object.keys(realBody).join(','));

async function mint(retries = 6) {
  for (let i = 0; i < retries; i++) {
    const r = await fetch(`${APP}/api/perch-terminal/turn-ticket`, {
      method: 'POST',
      headers: { ...auth, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ surface: 'cli', profile: 'standard' }),
    });
    const j = await r.json();
    if (j.ok) return j;
    if (j.errorCode === 'turn_rate_limited') {
      const wait = 20000 * (i + 1);
      console.log(`rate limited, waiting ${wait / 1000}s...`);
      await new Promise((res) => setTimeout(res, wait));
      continue;
    }
    throw new Error(JSON.stringify(j));
  }
  throw new Error('could not mint ticket');
}

const ticket = await mint();
console.log('ticket ok, runId =', ticket.runId);

async function call(name, body, opts = {}) {
  const r = await fetch(`${APP}/api/perch-terminal/model-call`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
      ...auth,
      ...(opts.noTicket ? {} : { 'x-perch-turn-ticket': ticket.ticket }),
      'x-perch-call-delta': '1',
    },
    body: JSON.stringify(body),
  });
  const text = await r.text();
  const done = /"type":"done"/.test(text);
  const snippet = text.slice(0, 160).replace(/\s+/g, ' ');
  console.log(`[${name}] HTTP ${r.status}${done ? ' DONE' : ''} :: ${snippet}`);
  fs.writeFileSync(`data/matrix-${name}.txt`, text);
  return { status: r.status, done, text };
}

const clone = (o) => JSON.parse(JSON.stringify(o));

// A. exact captured body
await call('A-control', realBody);

// B. same but no tools
{
  const b = clone(realBody);
  delete b.request.tools;
  delete b.request.toolChoice;
  await call('B-notools', b);
}

// C. same but only the user message (no 43 KB system prompt)
{
  const b = clone(realBody);
  b.request.messages = b.request.messages.filter((m) => m.role !== 'system');
  await call('C-nosystem', b);
}

// D. minimal body but with tools + full top-level key set
{
  const b = clone(realBody);
  b.request.messages = [
    { role: 'system', content: 'You are a terse assistant.' },
    { role: 'user', content: 'Say pong.' },
  ];
  await call('D-short', b);
}

// E. minimal everything: only request{tools} + runId/lane/clientSurface
{
  await call('E-skeleton', {
    request: {
      messages: [{ role: 'user', content: 'Say pong.' }],
      tools: realBody.request.tools,
      maxTokens: 16,
    },
    runId: ticket.runId,
    lane: 'chat',
    clientSurface: 'cli',
  });
}

// F. control without the turn-ticket header
await call('F-noticket', realBody, { noTicket: true });

// G. control with a non-perch UA
{
  const r = await fetch(`${APP}/api/perch-terminal/model-call`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
      Authorization: `Bearer ${session.accessToken}`,
      'User-Agent': 'node',
      'x-perch-locale': 'en',
      'x-perch-turn-ticket': ticket.ticket,
    },
    body: JSON.stringify(realBody),
  });
  const text = await r.text();
  console.log(`[G-nodeUA] HTTP ${r.status} :: ${text.slice(0, 160).replace(/\s+/g, ' ')}`);
}
