#!/usr/bin/env node
/**
 * Model-selection + ticket-requirement probe.
 * Everything uses the gate-satisfying system prefix discovered previously.
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

async function call(name, { top = {}, useTicket = true, runId = ticket.runId, userText = 'Say pong only.' } = {}) {
  const body = {
    request: {
      messages: [
        { role: 'system', content: PREFIX },
        { role: 'user', content: userText },
      ],
      maxTokens: 24,
    },
    runId,
    lane: 'chat',
    strictManual: false,
    clientSurface: 'cli',
    attribution: { ...realBody.attribution, runId },
    avoidModelIds: [],
    resendAfterOutput: true,
    ...top,
  };
  const headers = {
    'Content-Type': 'application/json',
    Accept: 'text/event-stream',
    ...auth,
    'x-perch-call-delta': '1',
  };
  if (useTicket) headers['x-perch-turn-ticket'] = ticket.ticket;
  const t0 = Date.now();
  const r = await fetch(`${APP}/api/perch-terminal/model-call`, { method: 'POST', headers, body: JSON.stringify(body) });
  const text = await r.text();
  const ok = r.status === 200 && /"type":"done"/.test(text);
  const model = /"model":"([^"]+)"/.exec(text)?.[1] ?? '-';
  const provider = /"provider":"([^"]+)"/.exec(text)?.[1] ?? '-';
  const usage = /"usage":(\{[^}]*\})/.exec(text)?.[1] ?? '-';
  console.log(`[${name}] HTTP ${r.status}${ok ? ' PASS' : ' FAIL'} provider=${provider} model=${model} ${Date.now() - t0}ms`);
  if (!ok) console.log('   ', text.slice(0, 200).replace(/\s+/g, ' '));
  else console.log('    usage:', usage);
  fs.writeFileSync(`data/sel-${name}.txt`, text);
  return { ok, model, provider };
}

// 1. no ticket at all + random runId
await call('no-ticket-random-runid', { useTicket: false, runId: 'gw-' + Date.now() });
await new Promise((r) => setTimeout(r, 1200));

// 2. roost tiers
for (const tier of ['standard', 'pro', 'standard_max', 'pro_max']) {
  await call(`roost-${tier}`, { top: { roostModelChoice: tier, roostReasoning: false } });
  await new Promise((r) => setTimeout(r, 1500));
}

// 3. named pins
for (const id of ['wandb-kimi-k2-6', 'wandb-qwen3-6-35b-a3b', 'wandb-deepseek-ai-deepseek-v4-pro', 'cerebras-zai-glm-4.7-low']) {
  await call(`pin-${id}`, { top: { preferredModelId: id, strictManual: true } });
  await new Promise((r) => setTimeout(r, 1500));
}
