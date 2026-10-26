#!/usr/bin/env node
/**
 * Which Qwen 3.8 Max option id does the Starter plan actually serve?
 *
 * Perch's announcement (2026-10-25) says Qwen 3.8 Max is free on Starter until
 * Nov 20 and pins as `/model qwen-3.8-max`. The registry card for that alias is
 * `openrouter-qwen-qwen3-8-max-0902`, but the same file marks the card as leaving
 * the lineup when the Alibaba credit ends — so verify against `done.model`
 * instead of trusting either source.
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

const GATE = 'You are Saffron — Perch\u2019s workspace operator.\n'
  + 'Sharp, experienced, been around long enough to know what matters and what\u2019s noise. You work with '
  + 'analysts, operators, and founders on financial analysis, audits, document review, and whatever the '
  + 'workspace needs. You have opinions. You\u2019re direct. You genuinely enjoy finding something interesting '
  + 'buried in a mess.\n\n';

const candidates = [
  { label: 'alias literal', preferredModelId: 'qwen-3.8-max', strictManual: true },
  { label: 'registry card', preferredModelId: 'openrouter-qwen-qwen3-8-max-0902', strictManual: true },
  { label: 'flash control', preferredModelId: 'openrouter-qwen-qwen3-8-flash', strictManual: true },
  { label: 'roost standard', roostModelChoice: 'standard' },
];

for (const candidate of candidates) {
  const body = {
    request: {
      messages: [
        { role: 'system', content: GATE },
        { role: 'user', content: 'Reply with exactly: qwen-ok' },
      ],
      maxTokens: 24,
    },
    runId: `probe-qwen-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    lane: 'chat',
    clientSurface: 'cli',
    attribution: { userId: session.userId, source: 'cli', lane: 'chat' },
    resendAfterOutput: true,
  };
  if (candidate.preferredModelId) {
    body.preferredModelId = candidate.preferredModelId;
    body.strictManual = candidate.strictManual;
  }
  if (candidate.roostModelChoice) body.roostModelChoice = candidate.roostModelChoice;

  const started = Date.now();
  const response = await fetch(`${appUrl}/api/perch-terminal/model-call`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${session.accessToken}`,
      'Content-Type': 'application/json',
      'User-Agent': 'perchai-cli/2.4.118',
      'x-perch-locale': 'en',
      Accept: 'text/event-stream',
    },
    body: JSON.stringify(body),
  });

  let text = '';
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
          const payload = line.slice(5).trim();
          if (!payload) continue;
          let event = null;
          try { event = JSON.parse(payload); } catch { continue; }
          if (event.type === 'done') { text = JSON.stringify(event); break outer; }
          if (event.type === 'error' || event.ok === false) { text = JSON.stringify(event); break outer; }
        }
      }
    }
  } else {
    text = await response.text();
  }

  let parsed = null;
  try { parsed = JSON.parse(text); } catch { /* keep raw */ }
  const model = parsed?.model ?? parsed?.done?.model ?? '?';
  const errorCode = parsed?.errorCode ?? parsed?.error ?? '';
  console.log(
    `${String(candidate.label).padEnd(16)} http=${response.status} `
    + `model=${model} finish=${parsed?.finishReason ?? '-'} ${errorCode ? `err=${String(errorCode).slice(0, 60)}` : ''} ${Date.now() - started}ms`,
  );
  if (parsed?.usage) console.log(`  usage in=${parsed.usage.inputTokens} out=${parsed.usage.outputTokens}`);
  await new Promise((resolve) => setTimeout(resolve, 1200));
}
