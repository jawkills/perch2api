#!/usr/bin/env node
/**
 * Ask the live server which models this plan can actually pick.
 *
 * The desktop/CLI render their model picker from a server payload, so the
 * authoritative Starter list (including limited-time promo cards such as
 * Qwen 3.8 Max) is one authenticated GET away. Print the raw keys so we learn
 * the real option id instead of guessing one.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
const CANDIDATES = [
  process.env.PERCH_CLI_AUTH_DIR && path.join(process.env.PERCH_CLI_AUTH_DIR, 'cli-auth-session.json'),
  path.join(os.homedir(), '.perch', 'cli-auth-session.json'),
  path.join(appData, 'Perch AI Desktop', 'cli-auth-session.json'),
].filter(Boolean);

const sessionPath = CANDIDATES.find((p) => fs.existsSync(p));
if (!sessionPath) {
  console.error('no session file found');
  process.exit(1);
}
const session = JSON.parse(fs.readFileSync(sessionPath, 'utf8'));
const appUrl = (session.appUrl || 'https://app.perchai.app').replace(/\/+$/, '');

const headers = {
  Authorization: `Bearer ${session.accessToken}`,
  'User-Agent': 'perchai-cli/2.4.118',
  'x-perch-locale': 'en',
  Accept: 'application/json',
};

const routes = [
  ['GET', '/api/perch-terminal/public-model-default'],
  ['GET', '/api/perch-terminal/cli-context?query=qwen&lane=chat'],
  ['POST', '/api/perch-terminal/cli-context', { query: 'qwen', lane: 'chat' }],
  ['GET', '/api/perchai/account'],
];

function walk(value, prefix = '', depth = 0, out = []) {
  if (depth > 3 || value === null || typeof value !== 'object') return out;
  for (const [key, inner] of Object.entries(value)) {
    const label = `${prefix}${key}`;
    if (typeof inner === 'string' || typeof inner === 'number' || typeof inner === 'boolean') {
      out.push(`${label} = ${String(inner).slice(0, 90)}`);
    } else if (Array.isArray(inner)) {
      out.push(`${label}[] (${inner.length})`);
      if (inner.length) out.push(`  [0] ${JSON.stringify(inner[0]).slice(0, 200)}`);
    } else if (inner && typeof inner === 'object') {
      walk(inner, `${label}.`, depth + 1, out);
    }
  }
  return out;
}

for (const [method, route, body] of routes) {
  const response = await fetch(`${appUrl}${route}`, {
    method,
    headers: { ...headers, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  console.log(`\n=== ${method} ${route} -> ${response.status} (${text.length} bytes) ===`);
  let json = null;
  try { json = JSON.parse(text); } catch { /* not json */ }
  if (!json) {
    console.log(text.slice(0, 400));
    continue;
  }
  // Every model-ish leaf, so a promo card cannot hide inside a nested array.
  const hits = [];
  JSON.stringify(json).replace(/"([a-z0-9][a-z0-9._-]*qwen[a-z0-9._-]*)"/gi, (_, id) => { hits.push(id); return _; });
  console.log('qwen-ish ids:', [...new Set(hits)].join(', ') || '(none)');
  if (route.endsWith('account')) {
    console.log(walk(json).slice(0, 25).join('\n'));
  } else {
    console.log(walk(json).slice(0, 30).join('\n'));
  }
  fs.writeFileSync(`data/plan-${route.split('/').pop().replace(/[?=]/g, '_')}.json`, JSON.stringify(json, null, 2));
}
