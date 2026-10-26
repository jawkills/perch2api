/**
 * Perch session store.
 *
 * A Perch session is the `cli-auth-session.json` file the official CLI/Desktop
 * writes: { version, appUrl, accessToken, refreshToken, expiresAt, userId, email }.
 * The access token is a Supabase JWT, so refresh goes through the Supabase auth
 * endpoint the app advertises at /api/perch-terminal/cli-auth/config.
 *
 * Multiple session files are supported for rotation; each keeps its own token and
 * refresh lock.
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { config, SESSION_CANDIDATES, EXTRA_SESSION_FILES } from './config.mjs';

const REFRESH_MARGIN_S = 120;

export class SessionStore {
  /** @param {string[]} files */
  constructor(files) {
    this.slots = files.map((file) => ({
      file,
      session: null,
      inflight: 0,
      lastUsed: 0,
      refreshing: null,
      error: null,
    }));
    this.cursor = 0;
  }

  static discover() {
    const files = [];
    for (const p of [...SESSION_CANDIDATES, ...EXTRA_SESSION_FILES]) {
      if (fs.existsSync(p) && !files.includes(p)) files.push(p);
    }
    return new SessionStore(files);
  }

  get size() {
    return this.slots.length;
  }

  async reload() {
    for (const slot of this.slots) await this.#load(slot);
    return this.slots.filter((s) => s.session).length;
  }

  async #load(slot) {
    try {
      const raw = await fsp.readFile(slot.file, 'utf8');
      const parsed = JSON.parse(raw);
      if (!parsed?.accessToken) throw new Error('session file has no accessToken');
      slot.session = {
        version: parsed.version ?? 1,
        appUrl: (parsed.appUrl || config.appUrl).replace(/\/+$/, ''),
        accessToken: parsed.accessToken,
        refreshToken: parsed.refreshToken ?? null,
        expiresAt: typeof parsed.expiresAt === 'number' ? parsed.expiresAt : null,
        userId: parsed.userId ?? null,
        email: parsed.email ?? null,
        updatedAt: parsed.updatedAt ?? null,
      };
      slot.error = null;
    } catch (error) {
      slot.session = null;
      slot.error = error.message;
    }
  }

  /** Round-robin across usable slots: least in-flight, then least recently used. */
  pick() {
    const usable = this.slots.filter((s) => s.session);
    if (!usable.length) {
      throw Object.assign(new Error(
        'No Perch session found. Run `node scripts/login.mjs` or point PERCH_CLI_AUTH_DIR at a logged-in Perch profile.',
      ), { code: 'no_session' });
    }
    usable.sort((a, b) => (a.inflight - b.inflight) || (a.lastUsed - b.lastUsed));
    const slot = usable[0];
    slot.inflight += 1;
    slot.lastUsed = Date.now();
    return { slot, release: () => { slot.inflight = Math.max(0, slot.inflight - 1); } };
  }

  /** Return a valid access token for the slot, refreshing when it is close to expiry. */
  async token(slot, { force = false } = {}) {
    const session = slot.session;
    if (!session) throw Object.assign(new Error('session slot is empty'), { code: 'no_session' });
    const now = Math.floor(Date.now() / 1000);
    const expired = !session.expiresAt || session.expiresAt <= now + REFRESH_MARGIN_S;
    if (!expired && !force) return session.accessToken;
    if (!session.refreshToken) {
      if (!expired) return session.accessToken;
      throw Object.assign(new Error('Perch session expired and has no refresh token. Log in again.'),
        { code: 'session_expired' });
    }
    if (!slot.refreshing) slot.refreshing = this.#refresh(slot).finally(() => { slot.refreshing = null; });
    await slot.refreshing;
    return slot.session?.accessToken ?? null;
  }

  async #refresh(slot) {
    const session = slot.session;
    if (!session?.refreshToken) return;
    const base = session.appUrl || config.appUrl;

    const cfgRes = await fetch(`${base}/api/perch-terminal/cli-auth/config`, {
      headers: { Accept: 'application/json', 'User-Agent': config.userAgent },
      signal: AbortSignal.timeout(15_000),
    });
    if (!cfgRes.ok) throw new Error(`cli-auth/config HTTP ${cfgRes.status}`);
    const cfg = await cfgRes.json();
    if (!cfg?.supabaseUrl || !cfg?.supabaseAnonKey) throw new Error('cli-auth/config missing supabase credentials');

    const res = await fetch(`${cfg.supabaseUrl}/auth/v1/token?grant_type=refresh_token`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: cfg.supabaseAnonKey,
        Authorization: `Bearer ${cfg.supabaseAnonKey}`,
      },
      body: JSON.stringify({ refresh_token: session.refreshToken }),
      signal: AbortSignal.timeout(20_000),
    });
    const body = await res.json().catch(() => null);
    if (!res.ok || !body?.access_token) {
      throw Object.assign(new Error(`token refresh failed: HTTP ${res.status} ${body?.error_description || body?.error || ''}`.trim()),
        { code: 'refresh_failed' });
    }

    const next = {
      ...session,
      accessToken: body.access_token,
      refreshToken: body.refresh_token ?? session.refreshToken,
      expiresAt: typeof body.expires_at === 'number'
        ? body.expires_at
        : Math.floor(Date.now() / 1000) + (body.expires_in ?? 3600),
      userId: body.user?.id ?? session.userId,
      email: body.user?.email ?? session.email,
      updatedAt: new Date().toISOString(),
    };
    await this.#persist(slot, next);
  }

  async #persist(slot, session) {
    slot.session = session;
    try {
      await fsp.mkdir(path.dirname(slot.file), { recursive: true, mode: 0o700 });
      const tmp = `${slot.file}.${process.pid}.tmp`;
      await fsp.writeFile(tmp, JSON.stringify(session, null, 0), { mode: 0o600 });
      await fsp.rename(tmp, slot.file);
    } catch (error) {
      slot.error = `could not persist refreshed session: ${error.message}`;
    }
  }

  describe() {
    return this.slots.map((slot) => ({
      file: slot.file,
      email: slot.session?.email ?? null,
      userId: slot.session?.userId ?? null,
      expiresAt: slot.session?.expiresAt ?? null,
      ok: Boolean(slot.session),
      error: slot.error,
      inflight: slot.inflight,
    }));
  }
}
