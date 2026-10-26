/**
 * The upstream surface gate requires every model call to begin with Perch's own
 * operator preamble (about 200 characters are enough; text appended after it is
 * ignored by the check).
 *
 * OBSERVED (2026-10-26, live account): POST /api/perch-terminal/model-call answers
 * HTTP 403 `perch_surface_required` unless the FIRST system message starts with
 * that text. Length bisect: 190 chars fails, 200 passes.
 *
 * That text belongs to Perch, so this repository does not ship it. Supply it from
 * your own installation, either way:
 *
 *   1. node scripts/extract-prefix.mjs      # reads the Perch CLI you installed and
 *                                           # writes .perch-prefix.txt (gitignored)
 *   2. PERCH_SYSTEM_PREFIX="You are ..."    # inline, from any source
 *
 * Resolution order: env var, .perch-prefix.txt, then empty. With an empty prefix
 * every model call is refused upstream, so the server warns at startup instead of
 * failing silently on the first request.
 */
import fs from 'node:fs';
import path from 'node:path';

const FILE = path.join(process.cwd(), '.perch-prefix.txt');

/** Minimum prefix length that satisfied the gate during the bisect. */
export const PERCH_SYSTEM_PREFIX_MIN = 200;

function fromFile() {
  try {
    const text = fs.readFileSync(FILE, 'utf8').trim();
    if (!text) return '';
    // The opening line is under the minimum on its own, so take everything up to
    // the next blank line after the length the gate requires.
    const cut = text.indexOf('\n\n', PERCH_SYSTEM_PREFIX_MIN);
    const stop = cut > PERCH_SYSTEM_PREFIX_MIN ? cut : text.length;
    return text.slice(0, stop).trim();
  } catch {
    return '';
  }
}

export const PERCH_SYSTEM_PREFIX = (process.env.PERCH_SYSTEM_PREFIX || fromFile()).trim();

/** True when a prefix is configured; the server warns when it is not. */
export const HAS_SYSTEM_PREFIX = PERCH_SYSTEM_PREFIX.length > 0;

/** Where the prefix came from, for the startup banner. */
export const SYSTEM_PREFIX_SOURCE = process.env.PERCH_SYSTEM_PREFIX
  ? 'env PERCH_SYSTEM_PREFIX'
  : HAS_SYSTEM_PREFIX
    ? FILE
    : 'none';
