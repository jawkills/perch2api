#!/usr/bin/env node
/**
 * Extract files from an Electron app.asar and recover the original TypeScript that
 * the shipped source map carries in `sourcesContent`.
 *
 *   node re/extract.js [app.asar] [--out re] [--dump-sources]
 *
 * asar layout: [u32 4][u32 headerPickleSize][u32 jsonLen+4][u32 jsonLen][json][data...]
 * The data section starts at 8 + u32@4. Computing it as 16 + jsonLen instead lands
 * three bytes early on Perch's archive (jsonLen 20148561, padded to 20148564) and
 * silently corrupts every extracted file: three leading NULs, three bytes lost at
 * the tail, a `.map` that "needs cleaning" before it parses.
 */
const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const ASAR = args.find((a) => a.endsWith('.asar')) ||
  'C:/Users/Administrator/AppData/Local/Programs/Perch Terminal/resources/app.asar';
const OUT = args.includes('--out') ? args[args.indexOf('--out') + 1] : 're';
const DUMP_SOURCES = args.includes('--dump-sources');

const fd = fs.openSync(ASAR, 'r');
const head = Buffer.alloc(16);
fs.readSync(fd, head, 0, 16, 0);
const dataStart = 8 + head.readUInt32LE(4);
const jsonLen = head.readUInt32LE(12);
const headerBuf = Buffer.alloc(jsonLen);
fs.readSync(fd, headerBuf, 0, jsonLen, 16);
const header = JSON.parse(headerBuf.toString('utf8').replace(/\u0000+$/, ''));

console.log(`data section starts at ${dataStart}, header json ${jsonLen} bytes`);

function get(target) {
  let node = { files: header.files };
  for (const part of target.split('/')) {
    if (!node.files || !node.files[part]) return null;
    node = node.files[part];
  }
  return node;
}

function readEntry(entry) {
  const buf = Buffer.alloc(entry.size);
  fs.readSync(fd, buf, 0, entry.size, dataStart + Number(entry.offset));
  return buf;
}

const targets = args.filter((a) => !a.startsWith('--') && !a.endsWith('.asar') && a !== OUT);
const fallback = ['dist-electron/main.js', 'dist-electron/main.js.map', 'dist-electron/preload.js', 'package.json'];

for (const target of targets.length ? targets : fallback) {
  const entry = get(target);
  if (!entry) {
    console.log('MISS', target);
    continue;
  }
  if (entry.files) {
    console.log('DIR', target, Object.keys(entry.files).length);
    continue;
  }
  const out = path.join(OUT, target.replace(/[/\\]/g, '__'));
  fs.writeFileSync(out, readEntry(entry));
  console.log('OK', target, entry.size, '->', out);
}

if (DUMP_SOURCES) {
  const mapPath = path.join(OUT, 'dist-electron__main.js.map');
  if (!fs.existsSync(mapPath)) {
    console.log('no source map at', mapPath);
  } else {
    const map = JSON.parse(fs.readFileSync(mapPath, 'utf8'));
    console.log(`sourcemap: ${map.sources.length} sources, ${map.sourcesContent ? map.sourcesContent.length : 0} with content`);
    const root = path.join(OUT, 'src-main');
    let written = 0;
    map.sources.forEach((source, i) => {
      const content = map.sourcesContent && map.sourcesContent[i];
      if (!content) return;
      const rel = source.replace(/^(\.\.\/)+/, '');
      const target = path.join(root, rel);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, content);
      written += 1;
    });
    console.log(`recovered ${written} TypeScript sources into ${root}`);
  }
}

fs.closeSync(fd);
