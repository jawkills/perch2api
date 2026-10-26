/**
 * Build the Perch model alias table from the CLI bundle:
 *   alias ("kimi-3") -> registry option id ("openrouter-moonshotai-kimi-k3") + label
 */
import fs from 'node:fs';

const SRC = 're/cli/package/dist/perch.pretty.mjs';
const text = fs.readFileSync(SRC, 'utf8');

function sanitize(provider, model) {
  return `${provider.replace(/_/g, '-')}-${model.replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-+|-+$/g, '').toLowerCase()}`;
}

// 1. resolve minified identifiers assigned from pi("provider","model") or plain strings
const vars = new Map();
for (const m of text.matchAll(/([A-Za-z_$][\w$]*)\s*=\s*pi\(\s*"([^"]+)"\s*,\s*"([^"]+)"\s*\)/g)) {
  vars.set(m[1], sanitize(m[2], m[3]));
}
for (const m of text.matchAll(/([A-Za-z_$][\w$]*)\s*=\s*"([a-z0-9][a-z0-9._-]{4,})"/g)) {
  if (!vars.has(m[1])) vars.set(m[1], m[2]);
}

function extractObject(varName) {
  const idx = text.indexOf(`${varName} = {`);
  if (idx < 0) return null;
  const start = text.indexOf('{', idx);
  let depth = 0; let inStr = null; let end = -1;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inStr) { if (c === '\\') { i++; continue; } if (c === inStr) inStr = null; continue; }
    if (c === '"' || c === "'" || c === '`') { inStr = c; continue; }
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) { end = i; break; } }
  }
  return text.slice(start + 1, end);
}

const pairs = new Map();
for (const objName of ['Oee', 'Dee', 'xCr', 'Z3e']) {
  const body = extractObject(objName);
  if (!body) { console.log('missing object', objName); continue; }
  for (const m of body.matchAll(/(?:"([^"]+)"|([A-Za-z_$][\w$]*))\s*:\s*([A-Za-z_$][\w$]*|"[^"]+")/g)) {
    const alias = m[1] || m[2];
    let val = m[3];
    if (val.startsWith('"')) val = val.slice(1, -1);
    else val = vars.get(val) ?? `<unresolved:${val}>`;
    if (!/^"/.test(alias) && alias.length > 40) continue;
    pairs.set(alias, { optionId: val, group: objName });
  }
}

// labels
const labelBody = extractObject('iHe') || '';
const labels = {};
for (const m of labelBody.matchAll(/"([^"]+)"\s*:\s*"([^"]*)"/g)) labels[m[1]] = m[2];

const rows = [...pairs.entries()].map(([alias, v]) => ({
  alias,
  optionId: v.optionId,
  group: v.group,
  label: labels[alias] ?? alias,
})).filter((r) => !r.optionId.startsWith('<unresolved'));

fs.mkdirSync('data', { recursive: true });
fs.writeFileSync('data/model-aliases.json', JSON.stringify(rows, null, 2));
console.log('aliases:', rows.length);
for (const r of rows) console.log(` ${r.alias.padEnd(28)} -> ${r.optionId.padEnd(52)} ${r.label}`);
