#!/usr/bin/env node
/**
 * What is the accepted vision wire shape on model-call?
 *
 * The Desktop sources type image parts as OpenAI-style
 *   { type: "image_url", image_url: { url } }
 * and the CLI's vision lane builds exactly that. The remaining questions:
 *   - does the server accept a base64 `data:` URL, or only http(s)?
 *   - which lanes accept images (vision only? code? chat?)
 *   - does the persona-free `code` lane still accept images?
 *
 * Test image: 64x64 solid red PNG, generated locally so the answer is unambiguous.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';

// ---- minimal PNG writer (solid colour) --------------------------------------
function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i += 1) {
    c ^= buf[i];
    for (let k = 0; k < 8; k += 1) c = (c >>> 1) ^ (0xEDB88320 & -(c & 1));
  }
  return ~c >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
function solidPng(size, [r, g, b]) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 2;   // colour type RGB
  const raw = Buffer.alloc(size * (1 + size * 3));
  for (let y = 0; y < size; y += 1) {
    const row = y * (1 + size * 3);
    raw[row] = 0;
    for (let x = 0; x < size; x += 1) {
      raw[row + 1 + x * 3] = r;
      raw[row + 2 + x * 3] = g;
      raw[row + 3 + x * 3] = b;
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const png = solidPng(64, [220, 20, 20]);
fs.mkdirSync('data', { recursive: true });
fs.writeFileSync('data/red.png', png);
const dataUrl = `data:image/png;base64,${png.toString('base64')}`;
console.log(`test image: ${png.length} bytes, data URL ${dataUrl.length} chars\n`);

// ---- session ---------------------------------------------------------------
const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
const sessionPath = [
  process.env.PERCH_CLI_AUTH_DIR && path.join(process.env.PERCH_CLI_AUTH_DIR, 'cli-auth-session.json'),
  path.join(os.homedir(), '.perch', 'cli-auth-session.json'),
  path.join(appData, 'Perch AI Desktop', 'cli-auth-session.json'),
].filter(Boolean).find((p) => fs.existsSync(p));
const session = JSON.parse(fs.readFileSync(sessionPath, 'utf8'));
const appUrl = (session.appUrl || 'https://app.perchai.app').replace(/\/+$/, '');

const PREFIX = (process.env.PERCH_SYSTEM_PREFIX
  || (fs.existsSync('.perch-prefix.txt') ? fs.readFileSync('.perch-prefix.txt', 'utf8').trim() : '')) + String.fromCharCode(10, 10);

const QUESTION = {
  role: 'user',
  content: [
    { type: 'text', text: 'What single colour fills this image? Answer with just the colour name.' },
    { type: 'image_url', image_url: { url: dataUrl } },
  ],
};

const variants = [
  { label: 'lane=vision dataURL', lane: 'vision' },
  { label: 'lane=code dataURL', lane: 'code' },
  { label: 'lane=chat dataURL', lane: 'chat' },
  {
    label: 'lane=code img at top level',
    lane: 'code',
    extraBody: { images: [{ mimeType: 'image/png', data: png.toString('base64') }] },
    plainText: true,
  },
];

for (const variant of variants) {
  const messages = variant.plainText
    ? [{ role: 'system', content: PREFIX }, { role: 'user', content: 'What single colour fills the attached image?' }]
    : [{ role: 'system', content: PREFIX }, QUESTION];

  const body = {
    request: { messages, maxTokens: 80 },
    runId: `probe-vision-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    lane: variant.lane,
    strictManual: false,
    clientSurface: 'cli',
    attribution: { userId: session.userId, source: 'cli', lane: variant.lane },
    resendAfterOutput: true,
    preferredModelId: 'openrouter-qwen-qwen3-8-max-0902',
    manualModelOptionId: 'openrouter-qwen-qwen3-8-max-0902',
    ...(variant.extraBody || {}),
  };

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

  console.log(`${variant.label.padEnd(28)} http=${response.status} model=${model || '-'}`);
  if (errorCode) console.log(`   err: ${String(errorCode).slice(0, 120)}`);
  if (answer) console.log(`   reply: ${answer.replace(/\s+/g, ' ').trim().slice(0, 140)}`);
  await new Promise((resolve) => setTimeout(resolve, 1500));
}
