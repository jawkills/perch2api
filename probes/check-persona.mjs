#!/usr/bin/env node
/**
 * Persona regression: the agent harness path (big system prompt + tools) is where
 * the Perch persona used to leak through. Ask the gateway who it is, with an
 * OMP-style system prompt, and flag any Saffron / Quill / Perch self-identification.
 *
 *   node probes/check-persona.mjs
 */
import fs from 'node:fs';

const BASE = process.env.PERCH2API_BASE || 'http://127.0.0.1:8790';
let key = process.env.PERCH2API_KEY || '';
if (!key) {
  try {
    key = fs.readFileSync('.env', 'utf8').split('\n').find((l) => l.startsWith('PERCH2API_KEY='))?.split('=')[1]?.trim() || '';
  } catch { /* no .env */ }
}

const HARNESS = [
  'You are OMP, an autonomous coding agent running in a terminal.',
  'You have tools: read_file, write_file, run_shell, search_files.',
  'Work step by step, prefer evidence over assumptions, keep replies short.',
].join('\n');

const TOOLS = [
  { type: 'function', function: { name: 'run_shell', description: 'Run a shell command', parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] } } },
  { type: 'function', function: { name: 'read_file', description: 'Read a file', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } } },
];

const cases = [
  ['no system prompt', [], 'Who are you? One sentence.'],
  ['agent harness + tools', [{ role: 'system', content: HARNESS }], 'Who are you? One sentence.', TOOLS],
  ['tools, no system prompt', [], 'Who are you? One sentence.', TOOLS],
  ['tools + capability question', [{ role: 'system', content: HARNESS }], 'What can you do? Two lines max.', TOOLS],
  ['agent harness prompt', [{ role: 'system', content: HARNESS }], 'Who are you? One sentence.'],
  ['agent harness + long task', [{ role: 'system', content: HARNESS }],
    'Introduce yourself in one line, then say what model you are.'],
];

const BAD = /saffron|quill|perch'?s workspace operator|workspace operator/i;

for (const [label, system, question, tools] of cases) {
  const body = {
    model: process.env.PERCH2API_MODEL || 'qwen-3.8-max',
    messages: [...system, { role: 'user', content: question }],
    temperature: 0.2,
    max_tokens: 120,
    stream: false,
    ...(tools ? { tools } : {}),
  };
  const started = Date.now();
  const res = await fetch(`${BASE}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(key ? { Authorization: `Bearer ${key}` } : {}) },
    body: JSON.stringify(body),
  });
  const payload = await res.json().catch(() => ({}));
  const text = payload?.choices?.[0]?.message?.content ?? JSON.stringify(payload).slice(0, 200);
  const lowered = text.toLowerCase();
  const hit = BAD.test(text) || /saffron|quill/.test(lowered);
  console.log(`\n[${label}] http=${res.status} ${Date.now() - started}ms served=${payload?.model || '?'}`);
  console.log(`  ${hit ? 'FAIL persona leak' : 'PASS no persona'} :: ${text.replace(/\s+/g, ' ').slice(0, 220)}`);
}
