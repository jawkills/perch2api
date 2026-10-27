#!/usr/bin/env node
/**
 * Is the pin really the model it claims? Ask the proxy for qwen-3.8-max and inspect
 * everything the wire gives us:
 *   1. response headers that mention model/provider/route
 *   2. every top-level key in the SSE frames (model markers, provider hints)
 *   3. the terminal `done` frame verbatim
 *   4. the model's own answer to "which exact model and version are you"
 *
 *   node probes/probe-qwen-identity.mjs [manualModelOptionId]
 */
import fs from 'node:fs';
import path from 'node:path';

const OPTION = process.argv[2] || 'openrouter-qwen-qwen3-8-max-0902';
const PREFIX = fs.readFileSync('.perch-prefix.txt', 'utf8').trim();
const sessionPath = path.join(process.env.APPDATA, 'Perch AI Desktop', 'cli-auth-session.json');
const session = JSON.parse(fs.readFileSync(sessionPath, 'utf8'));
const APP = (session.appUrl || 'https://app.perchai.app').replace(/\/+$/, '');

const ask = async (question) => {
  const started = Date.now();
  const res = await fetch(`${APP}/api/perch-terminal/model-call`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${session.accessToken}`,
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
      'User-Agent': 'perchai-cli/2.4.118',
      'x-perch-locale': 'en',
    },
    body: JSON.stringify({
      request: {
        messages: [
          { role: 'system', content: `${PREFIX}\n\nYou are a helpful assistant.` },
          { role: 'user', content: question },
        ],
        maxTokens: 90,
      },
      runId: `probe-identity-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      lane: 'code',
      preferredModelId: 'qwen-3.8-max',
      manualModelOptionId: OPTION,
      strictManual: false,
      clientSurface: 'cli',
    }),
  });

  const text = await res.text();
  const lines = text.split('\n').filter((l) => l.startsWith('data: '));
  const frames = [];
  for (const line of lines) {
    try { frames.push(JSON.parse(line.slice(6))); } catch { /* partial */ }
  }
  const answer = frames.map((f) => f.delta ?? f.text ?? '').join('') ||
    frames.map((f) => f.answer ?? '').join('');
  return { status: res.status, headers: res.headers, frames, text, answer, ms: Date.now() - started };
};

const first = await ask('Which exact model and version are you? Give the family, the version, and the release tag if you know it. If unsure, say unknown.');

console.log('=== http:', first.status, `(${first.ms}ms)`);
const headerHints = {};
for (const [k, v] of first.headers.entries()) {
  if (/model|provider|route|upstream|server|x-[a-z-]+$/i.test(k)) headerHints[k] = v;
}
console.log('=== headers:', JSON.stringify(headerHints, null, 2));

const keys = new Map();
const markers = new Set();
const walk = (obj, prefix = '') => {
  for (const [k, v] of Object.entries(obj || {})) {
    const at = prefix ? `${prefix}.${k}` : k;
    keys.set(at, (keys.get(at) || 0) + 1);
    if (/model|provider|route|upstream|variant|version/i.test(k) && typeof v === 'string') {
      markers.add(`${at}=${v}`);
    }
    if (v && typeof v === 'object' && !Array.isArray(v)) walk(v, at);
  }
};
for (const frame of first.frames) walk(frame);

console.log('=== frame keys:', [...keys.entries()].map(([k, n]) => `${k}(${n})`).join(' '));
console.log('=== model/provider markers:');
for (const m of markers) console.log('   ', m);
console.log('=== last frame:\n', JSON.stringify(first.frames.at(-1), null, 2)?.slice(0, 1200));

fs.writeFileSync('data/raw-frame-qwen.txt', first.text);
console.log('=== raw stream saved to data/raw-frame-qwen.txt');

const second = await ask('In one line: is your internal model id qwen3-8-max-0902, or a different build? Answer with the id you believe you are, nothing else.');
console.log('\n=== self-report:', second.status, JSON.stringify(second.answer.replace(/\s+/g, ' ').slice(0, 300)));
