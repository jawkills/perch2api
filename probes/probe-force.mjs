#!/usr/bin/env node
/**
 * Is the account forced onto one model, or are pins merely silently ignored?
 *
 * Discriminator: if the router honoured pins at all, `deepseek-flash-starter`
 * (a different model: DeepSeek V4 Flash) would come back as V4 Flash, and an
 * `avoidModelIds` entry naming the served model would move the turn elsewhere.
 * If every variant still reports deepseek-ai/DeepSeek-V4.1-Flash, the account
 * cohort is pinned server-side and no client field can change it.
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

const GATE = (process.env.PERCH_SYSTEM_PREFIX
  || (fs.existsSync('.perch-prefix.txt') ? fs.readFileSync('.perch-prefix.txt', 'utf8').trim() : '')) + String.fromCharCode(10, 10);

const QWEN = 'openrouter-qwen-qwen3-8-max-0902';
const DEEPSEEK_STARTER = 'deepseek-flash-starter';

const variants = [
  { label: 'qwen + raceMode', preferredModelId: QWEN, strictManual: true, raceMode: 'single' },
  { label: 'qwen + avoid', preferredModelId: QWEN, strictManual: true, avoidModelIds: ['wandb-deepseek-ai-deepseek-v4-1-flash-1017'] },
  { label: 'ds-flash-starter', preferredModelId: DEEPSEEK_STARTER, strictManual: true },
  { label: 'raceMode single only', raceMode: 'single' },
  { label: 'baseline', },
];

for (const variant of variants) {
  const body = {
    request: {
      messages: [
        { role: 'system', content: GATE },
        { role: 'user', content: 'Say: ok' },
      ],
      maxTokens: 16,
    },
    runId: `probe-force-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    lane: 'chat',
    clientSurface: 'cli',
    attribution: { userId: session.userId, source: 'cli', lane: 'chat' },
    resendAfterOutput: true,
    ...variant,
  };
  delete body.label;

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

  let done = null;
  let errorPayload = null;
  if ((response.headers.get('content-type') || '').includes('text/event-stream')) {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    outer: while (true) {
      const { value, done: finished } = await reader.read();
      if (finished) break;
      buffer += decoder.decode(value, { stream: true });
      const frames = buffer.split('\n\n');
      buffer = frames.pop() ?? '';
      for (const frame of frames) {
        for (const line of frame.split('\n')) {
          if (!line.startsWith('data:')) continue;
          let event = null;
          try { event = JSON.parse(line.slice(5).trim()); } catch { continue; }
          if (event.type === 'done') { done = event; break outer; }
        }
      }
    }
  } else {
    errorPayload = await response.json().catch(() => null);
  }

  console.log(
    `${String(variant.label).padEnd(22)} http=${response.status} `
    + `model=${done?.model ?? errorPayload?.error ?? '?'} `
    + `finish=${done?.finishReason ?? '-'} ${errorPayload?.errorCode ?? ''}`,
  );
  await new Promise((resolve) => setTimeout(resolve, 1000));
}
