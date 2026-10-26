#!/usr/bin/env node
/**
 * Read-only reconnaissance against the Perch app backend using a live CLI session.
 * Does not spend model credits: only reads config + mints a turn ticket.
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const SESSION_CANDIDATES = [
  process.env.PERCH_CLI_AUTH_DIR ? path.join(process.env.PERCH_CLI_AUTH_DIR, 'cli-auth-session.json') : null,
  path.join(os.homedir(), '.perch', 'cli-auth-session.json'),
  path.join(process.env.APPDATA || '', 'Perch AI Desktop', 'cli-auth-session.json'),
].filter(Boolean);

function loadSession() {
  for (const p of SESSION_CANDIDATES) {
    if (fs.existsSync(p)) return { path: p, session: JSON.parse(fs.readFileSync(p, 'utf8')) };
  }
  throw new Error('no cli-auth-session.json found');
}

const { path: sessPath, session } = loadSession();
const APP = session.appUrl || 'https://app.perchai.app';
const UA = `perchai-cli/${process.env.PERCH_CLI_VERSION || '2.4.118'}`;

console.log('session file:', sessPath);
console.log('appUrl:', APP);

async function jget(url, headers) {
  const r = await fetch(url, { headers, signal: AbortSignal.timeout(15000) });
  const text = await r.text();
  let body; try { body = JSON.parse(text); } catch { body = text.slice(0, 400); }
  return { status: r.status, headers: Object.fromEntries(r.headers), body };
}

const baseHeaders = {
  Accept: 'application/json',
  'User-Agent': UA,
  Authorization: `Bearer ${session.accessToken}`,
  'x-perch-locale': 'en',
};

const out = {};

// 1. auth config (supabase url + anon key + providers)
out.authConfig = await jget(`${APP}/api/perch-terminal/cli-auth/config`, { Accept: 'application/json', 'User-Agent': UA });
if (out.authConfig.body && typeof out.authConfig.body === 'object') {
  const b = { ...out.authConfig.body };
  if (b.supabaseAnonKey) b.supabaseAnonKey = b.supabaseAnonKey.slice(0, 12) + '...';
  out.authConfig.body = b;
}

// 2. public model default
out.publicModelDefault = await jget(`${APP}/api/perch-terminal/public-model-default`, baseHeaders);

// 3. session context (may reveal plan / tier / limits)
out.sessionContext = await jget(`${APP}/api/perch-terminal/session-context`, baseHeaders);

// 4. turn ticket mint
{
  const r = await fetch(`${APP}/api/perch-terminal/turn-ticket`, {
    method: 'POST',
    headers: { ...baseHeaders, 'Content-Type': 'application/json' },
    body: JSON.stringify({ surface: 'cli', profile: 'standard' }),
    signal: AbortSignal.timeout(15000),
  });
  const text = await r.text();
  let body; try { body = JSON.parse(text); } catch { body = text.slice(0, 600); }
  if (body && typeof body === 'object' && body.ticket) {
    body.ticket = body.ticket.slice(0, 16) + '... (len ' + body.ticket.length + ')';
  }
  out.turnTicket = { status: r.status, body };
}

console.log(JSON.stringify(out, null, 2));
fs.writeFileSync(path.join(process.cwd(), 'probe-read.json'), JSON.stringify(out, null, 2));
