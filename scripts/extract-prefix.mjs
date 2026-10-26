#!/usr/bin/env node
/**
 * Derive the surface-gate prefix from a Perch client you already have installed,
 * and write it to .perch-prefix.txt (gitignored). Nothing is downloaded, and this
 * repository ships none of Perch's text.
 *
 *   node scripts/extract-prefix.mjs                     # auto-detect
 *   node scripts/extract-prefix.mjs path/to/perch.mjs   # explicit bundle
 *
 * The prefix is the opening paragraph of the CLI's system prompt. The bundle keeps
 * it inside a JS string literal, so it arrives escaped ("\n", "\u2014") and has to
 * be decoded before use. ~200 characters is what the gate compares; the whole
 * opening paragraph (~361) is used for margin.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const MIN = 200;
const MAX = 4000;
const ANCHOR = 'You are Saffron';
const OUT = path.join(process.cwd(), '.perch-prefix.txt');
const BACKSLASH = String.fromCharCode(92);
const NL = String.fromCharCode(10);

function candidates() {
  const list = [];
  if (process.argv[2]) list.push(process.argv[2]);
  if (process.env.PERCH_CLI_PATH) list.push(process.env.PERCH_CLI_PATH);

  list.push(
    path.join(process.env.APPDATA || '', 'npm', 'node_modules', 'perchai-cli', 'dist', 'perch.mjs'),
    path.join('/usr/local/lib/node_modules/perchai-cli/dist/perch.mjs'),
    path.join(os.homedir(), '.npm-global', 'lib', 'node_modules', 'perchai-cli', 'dist', 'perch.mjs'),
  );

  // npx cache, where `npx perchai-cli` leaves the package
  try {
    const cache = path.join(process.env.LOCALAPPDATA || os.homedir(), 'npm-cache', '_npx');
    for (const entry of fs.readdirSync(cache)) {
      list.push(path.join(cache, entry, 'node_modules', 'perchai-cli', 'dist', 'perch.mjs'));
    }
  } catch { /* no npx cache */ }

  try {
    const prefix = execFileSync('npm', ['prefix', '-g'], { encoding: 'utf8' }).trim();
    list.push(path.join(prefix, 'node_modules', 'perchai-cli', 'dist', 'perch.mjs'));
  } catch { /* npm absent */ }

  return list.filter((file) => {
    try { return fs.statSync(file).isFile(); } catch { return false; }
  });
}

/** Decode a JS string-literal body character by character (no regex escaping). */
function unescapeLiteral(raw) {
  let out = '';
  for (let i = 0; i < raw.length; i += 1) {
    const ch = raw[i];
    if (ch !== BACKSLASH) { out += ch; continue; }
    const next = raw[i + 1];
    i += 1;
    switch (next) {
      case 'n': out += NL; break;
      case 'r': out += String.fromCharCode(13); break;
      case 't': out += String.fromCharCode(9); break;
      case 'b': out += String.fromCharCode(8); break;
      case 'f': out += String.fromCharCode(12); break;
      case 'v': out += String.fromCharCode(11); break;
      case '0': out += String.fromCharCode(0); break;
      case '"':
      case "'":
      case '`':
      case BACKSLASH:
      case '/':
        out += next;
        break;
      case 'x':
        out += String.fromCharCode(Number.parseInt(raw.slice(i + 1, i + 3), 16));
        i += 2;
        break;
      case 'u':
        if (raw[i + 1] === '{') {
          const close = raw.indexOf('}', i);
          out += String.fromCodePoint(Number.parseInt(raw.slice(i + 2, close), 16));
          i = close;
        } else {
          out += String.fromCharCode(Number.parseInt(raw.slice(i + 1, i + 5), 16));
          i += 4;
        }
        break;
      default:
        out += next;
    }
  }
  return out;
}

function extract(bundlePath) {
  const source = fs.readFileSync(bundlePath, 'utf8');
  const at = source.indexOf(ANCHOR);
  if (at < 0) return null;

  // The anchor sits inside a JS literal. Find which delimiter opened it by
  // scanning backwards: the prompt is often a template literal (`...`), and a
  // naive walk would stop at the apostrophe in "Perch's".
  let delimiter = null;
  for (let i = at - 1; i >= 0 && at - i < 400; i -= 1) {
    const ch = source[i];
    if (ch === '"' || ch === "'" || ch === '`') { delimiter = ch; break; }
  }
  if (!delimiter) return null;

  let end = at;
  while (end < source.length && end - at < MAX * 2) {
    const ch = source[end];
    if (ch === BACKSLASH) { end += 2; continue; }
    if (ch === delimiter) break;
    end += 1;
  }

  const decoded = unescapeLiteral(source.slice(at, end)).trim();
  // The opening line alone is under 200 chars, so extend to the next paragraph
  // break after the minimum; fall back to a word boundary if there is none.
  let cut = decoded.indexOf(NL + NL, MIN);
  if (cut < 0) cut = decoded.lastIndexOf(' ', MIN + 200);
  if (cut < MIN) cut = Math.min(decoded.length, MIN);
  const prefix = decoded.slice(0, cut).trim();
  return prefix.length >= MIN ? prefix : null;
}

const found = candidates();
if (!found.length) {
  console.error('No perchai-cli bundle found. Install it (npm i -g perchai-cli) or pass a path:');
  console.error('  node scripts/extract-prefix.mjs /path/to/node_modules/perchai-cli/dist/perch.mjs');
  process.exit(1);
}

for (const bundle of found) {
  const prefix = extract(bundle);
  if (!prefix) {
    console.log(`skip (anchor not found): ${bundle}`);
    continue;
  }
  fs.writeFileSync(OUT, prefix + NL);
  console.log(`prefix: ${prefix.length} chars from ${bundle}`);
  console.log('written to .perch-prefix.txt (gitignored)');
  console.log(`starts with: ${JSON.stringify(prefix.slice(0, 60))}`);
  process.exit(0);
}

console.error('Found a bundle but not the expected prompt anchor; pass the path explicitly.');
process.exit(1);
