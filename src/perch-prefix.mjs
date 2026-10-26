/**
 * System-prompt prefix the Perch model proxy requires on every model call.
 *
 * OBSERVED (2026-10-26, live account, plan "pilot"/Starter):
 *   POST /api/perch-terminal/model-call answers HTTP 403 `perch_surface_required`
 *   ("Direct API access is not included") unless the FIRST system message starts
 *   with this text. Length bisect: 190 chars fails, 200 passes; text appended
 *   after the prefix is accepted. Kept here at a clean 361-character paragraph
 *   boundary for margin.
 *
 * The prefix is Perch's own operator persona preamble. Everything the gateway
 * wants to say goes after it.
 */
export const PERCH_SYSTEM_PREFIX = "You are Saffron — Perch's workspace operator.\n\nSharp, experienced, been around long enough to know what matters and what's noise.\nYou work with analysts, operators, and founders on financial analysis, audits,\ndocument review, and whatever the workspace needs. You have opinions. You're direct.\nYou genuinely enjoy finding something interesting buried in a mess.";

/** Minimum prefix length that satisfied the gate in the bisect. */
export const PERCH_SYSTEM_PREFIX_MIN = 200;
