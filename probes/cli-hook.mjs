/**
 * fetch interceptor for the Perch CLI.
 * Logs every outbound HTTP request/response to ./capture/ so we can read the
 * real wire contract without a TLS MITM proxy.
 */
import fs from 'node:fs';
import path from 'node:path';

const OUT = path.resolve(process.cwd(), 'capture');
fs.mkdirSync(OUT, { recursive: true });

let seq = 0;
const origFetch = globalThis.fetch;

function redactAuth(h) {
  const out = {};
  for (const [k, v] of Object.entries(h || {})) {
    if (/^authorization$/i.test(k)) {
      out[k] = String(v).slice(0, 16) + `... (len ${String(v).length})`;
    } else {
      out[k] = v;
    }
  }
  return out;
}

globalThis.fetch = async function patchedFetch(input, init = {}) {
  const id = ++seq;
  const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
  const method = init.method || (typeof input === 'object' && input.method) || 'GET';
  let bodyText = null;
  if (typeof init.body === 'string') bodyText = init.body;
  else if (init.body && typeof init.body.toString === 'function' && init.body.constructor?.name !== 'ReadableStream') {
    try { bodyText = init.body.toString(); } catch {}
  }
  const reqHeaders = init.headers instanceof Headers
    ? Object.fromEntries(init.headers.entries())
    : Array.isArray(init.headers)
      ? Object.fromEntries(init.headers)
      : (init.headers || {});

  const record = {
    id, url, method,
    headers: redactAuth(reqHeaders),
    body: bodyText ? (bodyText.length > 200000 ? bodyText.slice(0, 200000) + '\n...[truncated]' : bodyText) : null,
    at: new Date().toISOString(),
  };

  const res = await origFetch(input, init);

  record.status = res.status;
  record.responseHeaders = Object.fromEntries(res.headers.entries());

  // Clone so we can capture the body without disturbing the caller.
  try {
    const clone = res.clone();
    const ctype = res.headers.get('content-type') || '';
    if (ctype.includes('text/event-stream')) {
      // stream: capture up to 400 KB as text
      const reader = clone.body.getReader();
      const dec = new TextDecoder();
      let acc = '';
      const t0 = Date.now();
      while (acc.length < 400000 && Date.now() - t0 < 180000) {
        const { done, value } = await reader.read();
        if (done) break;
        acc += dec.decode(value, { stream: true });
      }
      reader.cancel().catch(() => {});
      record.responseBody = acc + (acc.length >= 400000 ? '\n...[truncated]' : '');
      record.streamCaptured = true;
    } else {
      const text = await clone.text();
      record.responseBody = text.length > 200000 ? text.slice(0, 200000) + '\n...[truncated]' : text;
    }
  } catch (e) {
    record.responseBody = `<capture error: ${e.message}>`;
  }

  const safe = url.replace(/[^a-z0-9]+/gi, '_').slice(0, 80);
  fs.writeFileSync(path.join(OUT, `${String(id).padStart(3, '0')}_${safe}.json`), JSON.stringify(record, null, 2));
  fs.appendFileSync(path.join(OUT, 'index.log'), `${id}\t${method}\t${res.status}\t${url}\n`);
  return res;
};

console.error('[hook] fetch interception active ->', OUT);
