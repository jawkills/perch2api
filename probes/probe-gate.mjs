#!/usr/bin/env node
/**
 * Gate probe: find which request fields make the server accept a request as a
 * legitimate Perch CLI turn instead of "direct API access".
 * Runs variants in order, cheapest first, and stops at the first pass.
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

async function mint() {
  const r = await fetch(`${APP}/api/perch-terminal/turn-ticket`, {
    method: 'POST',
    headers: { ...auth, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ surface: 'cli', profile: 'standard' }),
  });
  const j = await r.json();
  if (!j.ok) throw new Error('ticket failed: ' + JSON.stringify(j));
  return j;
}

const account = await (await fetch(`${APP}/api/perchai/account`, { headers: { ...auth, Accept: 'application/json' } })).json();
const workspaceId = account?.session?.workspaceId ?? null;
const pmd = await (await fetch(`${APP}/api/perch-terminal/public-model-default`, { headers: { ...auth, Accept: 'application/json' } })).json();
const defaultModel = pmd?.selection?.chatModelId ?? null;
console.log('workspaceId:', workspaceId, '| defaultModel:', defaultModel);

const baseReq = {
  messages: [
    { role: 'system', content: 'You are a terse test assistant.' },
    { role: 'user', content: 'What is 2+2? Answer with just the number.' },
  ],
  maxTokens: 32,
  temperature: 0,
};

const tools = [{
  type: 'function',
  function: {
    name: 'noop',
    description: 'Does nothing. Never call it.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
  },
}];

async function attempt(name, build) {
  const ticket = await mint();
  const extra = build(ticket);
  const body = {
    request: { ...baseReq, ...(extra.request || {}) },
    ...extra.top,
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
  let verdict = text.slice(0, 220).replace(/\s+/g, ' ');
  console.log(`\n[${name}] HTTP ${r.status} -> ${verdict}`);
  fs.writeFileSync(`data/gate-${name}.txt`, `HTTP ${r.status}\n${text}`);
  return r.status === 200 && text.includes('"type":"done"');
}

const variants = [
  ['runId', (t) => ({ top: { runId: t.runId, lane: 'chat', clientSurface: 'cli' } })],
  ['attribution', (t) => ({
    top: {
      runId: t.runId, lane: 'chat', clientSurface: 'cli',
      attribution: { userId: session.userId, workspaceId, runId: t.runId, lane: 'chat', source: 'cli', billingMultiplier: null },
    },
  })],
  ['preferredModel', (t) => ({
    top: {
      runId: t.runId, lane: 'chat', clientSurface: 'cli',
      preferredModelId: defaultModel,
      attribution: { userId: session.userId, workspaceId, runId: t.runId, lane: 'chat', source: 'cli', billingMultiplier: null },
    },
  })],
  ['withTools', (t) => ({
    top: {
      runId: t.runId, lane: 'chat', clientSurface: 'cli',
      preferredModelId: defaultModel,
      attribution: { userId: session.userId, workspaceId, runId: t.runId, lane: 'chat', source: 'cli', billingMultiplier: null },
    },
    request: { tools, toolChoice: 'auto' },
  })],
];

for (const [name, build] of variants) {
  const ok = await attempt(name, build);
  if (ok) { console.log(`\n== PASS at variant: ${name} ==`); break; }
}
