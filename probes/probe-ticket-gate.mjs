#!/usr/bin/env node
/**
 * Is a valid turn ticket the durable surface proof (i.e. does it bypass the
 * system-prompt gate)?
 *
 * The client source says the prompt check is a tripwire and that "server-issued
 * run tickets remain the durable fix". If that is true, a minted ticket should
 * let a request through with NO Perch preamble at all — which is the only way to
 * keep the Saffron persona out of the model's context.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
const sessionPath = [
  process.env.PERCH_CLI_AUTH_DIR && path.join(process.env.PERCH_CLI_AUTH_DIR, 'cli-auth-session.json'),
  path.join(os.homedir(), '.perch', 'cli-auth-session.json'),
  path.join(appData, 'Perch AI Desktop', 'cli-auth-session.json'),
].filter(Boolean).find((p) => fs.existsSync(p));
const session = JSON.parse(fs.readFileSync(sessionPath, 'utf8'));
const appUrl = (session.appUrl || 'https://app.perchai.app').replace(/\/+$/, '');

const baseHeaders = {
  Authorization: `Bearer ${session.accessToken}`,
  'Content-Type': 'application/json',
  'User-Agent': 'perchai-cli/2.4.118',
  'x-perch-locale': 'en',
  Accept: 'text/event-stream',
};

const PREFIX = 'You are Saffron — Perch\u2019s workspace operator.\n'
  + 'Sharp, experienced, been around long enough to know what matters and what\u2019s noise. You work with '
  + 'analysts, operators, and founders on financial analysis, audits, document review, and whatever the '
  + 'workspace needs. You have opinions. You\u2019re direct. You genuinely enjoy finding something interesting '
  + 'buried in a mess.\n\n';

async function mint() {
  const response = await fetch(`${appUrl}/api/perch-terminal/turn-ticket`, {
    method: 'POST',
    headers: baseHeaders,
    body: JSON.stringify({ surface: 'cli', profile: 'standard' }),
  });
  const json = await response.json().catch(() => null);
  console.log(`mint -> ${response.status} id=${json?.ticketId ?? '-'} runId=${json?.runId ?? '-'} enforced=${json?.enforced}`);
  return json;
}

async function call({ label, ticket, runId, messages, headers: extra = {} }) {
  const body = {
    request: { messages, maxTokens: 60 },
    runId,
    lane: 'chat',
    strictManual: false,
    clientSurface: 'cli',
    attribution: { userId: session.userId, source: 'cli', lane: 'chat', runId },
    resendAfterOutput: true,
  };
  const response = await fetch(`${appUrl}/api/perch-terminal/model-call`, {
    method: 'POST',
    headers: { ...baseHeaders, ...(ticket ? { 'x-perch-turn-ticket': ticket } : {}), ...extra },
    body: JSON.stringify(body),
  });

  let answer = '';
  let model = '';
  let errorCode = '';
  if ((response.headers.get('content-type') || '').includes('text/event-stream')) {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    outer: while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const frames = buffer.split('\n\n');
      buffer = frames.pop() ?? '';
      for (const frame of frames) {
        for (const line of frame.split('\n')) {
          if (!line.startsWith('data:')) continue;
          let event = null;
          try { event = JSON.parse(line.slice(5).trim()); } catch { continue; }
          if (event.type === 'done') { answer = event.text || ''; model = event.model || ''; break outer; }
        }
      }
    }
  } else {
    const payload = await response.json().catch(() => ({}));
    errorCode = payload.errorCode || payload.error || '';
  }

  console.log(`${label.padEnd(30)} http=${response.status} model=${model || '-'}`);
  if (errorCode) console.log(`   error: ${String(errorCode).slice(0, 110)}`);
  if (answer) console.log(`   reply: ${answer.replace(/\s+/g, ' ').trim().slice(0, 130)}`);
}

const QUESTION = { role: 'user', content: 'Who are you? Answer in one short sentence.' };

const ticket = await mint();
if (!ticket?.ticket) {
  console.log('no ticket minted, aborting (rate limit?)');
  process.exit(0);
}
await new Promise((resolve) => setTimeout(resolve, 1500));

await call({
  label: 'ticket + runId, no prefix',
  ticket: ticket.ticket,
  runId: ticket.runId,
  messages: [{ role: 'system', content: 'You are a plain assistant. Never claim a persona, brand or employer.' }, QUESTION],
});
await new Promise((resolve) => setTimeout(resolve, 1500));

await call({
  label: 'ticket, random runId, no prefix',
  ticket: ticket.ticket,
  runId: `probe-rand-${Date.now()}`,
  messages: [QUESTION],
});
await new Promise((resolve) => setTimeout(resolve, 1500));

await call({
  label: 'no ticket, no prefix (control)',
  runId: `probe-ctl-${Date.now()}`,
  messages: [QUESTION],
});
await new Promise((resolve) => setTimeout(resolve, 1500));

await call({
  label: 'ticket + prefix (control pass)',
  ticket: ticket.ticket,
  runId: ticket.runId,
  messages: [{ role: 'system', content: PREFIX }, QUESTION],
});
