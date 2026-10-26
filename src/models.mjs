/**
 * Model surface exposed by Perch2API.
 *
 * Two families are addressable:
 *   1. Roost tiers — the stable, plan-resolved slots Perch itself offers
 *      (standard / standard-max / pro / pro-max). Always valid; the server picks
 *      the backing model and enforces plan access.
 *   2. Named pins — alias names from the Perch client picker ("kimi-3",
 *      "deepseek-v4.1-flash-1017", ...). Resolved to a registry option id and sent
 *      as `preferredModelId` with `strictManual`.
 *
 * A caller may also pass a raw registry option id (e.g. "wandb-kimi-k2-6").
 */
import aliases from './model-aliases.json' with { type: 'json' };

export const ROOST_TIERS = {
  standard: {
    id: 'perch',
    aliases: ['perch', 'roost', 'standard', 'perch-standard', 'roost-standard', 'default'],
    tier: 'standard',
    context: 200_000,
    label: 'Perch Roost · Standard (200K)',
  },
  standard_max: {
    id: 'perch-standard-max',
    aliases: ['perch-standard-max', 'roost-standard-max', 'standard-max', 'standard_max', 'perch-1m'],
    tier: 'standard_max',
    context: 1_000_000,
    label: 'Perch Roost · Standard Max (1M)',
  },
  pro: {
    id: 'perch-pro',
    aliases: ['perch-pro', 'roost-pro', 'pro'],
    tier: 'pro',
    context: 200_000,
    label: 'Perch Roost · Pro (200K)',
  },
  pro_max: {
    id: 'perch-pro-max',
    aliases: ['perch-pro-max', 'roost-pro-max', 'pro-max', 'pro_max'],
    tier: 'pro_max',
    context: 1_000_000,
    label: 'Perch Roost · Pro Max (1M)',
  },
};

const TIER_BY_ALIAS = new Map();
for (const tier of Object.values(ROOST_TIERS)) {
  for (const alias of tier.aliases) TIER_BY_ALIAS.set(alias.toLowerCase(), tier);
}

/** alias -> option id, plus option id -> alias for the reverse lookup. */
const ALIAS_TO_OPTION = new Map();
const OPTION_TO_ALIAS = new Map();
for (const row of aliases) {
  ALIAS_TO_OPTION.set(row.alias.toLowerCase(), row);
  if (!OPTION_TO_ALIAS.has(row.optionId)) OPTION_TO_ALIAS.set(row.optionId, row);
}
const KNOWN_OPTION_IDS = new Set(OPTION_TO_ALIAS.keys());

/**
 * Resolve a caller-supplied model name into the fields the Perch model-call
 * needs. Unknown names fall back to the standard tier rather than failing, so a
 * client configured with an unexpected model name still gets an answer.
 */
export function resolveModel(name) {
  const raw = typeof name === 'string' ? name.trim() : '';
  const key = raw.toLowerCase();

  const tier = TIER_BY_ALIAS.get(key);
  if (tier) {
    return {
      requested: raw || tier.id,
      kind: 'roost',
      roostModelChoice: tier.tier,
      contextWindow: tier.context,
      label: tier.label,
    };
  }

  const alias = ALIAS_TO_OPTION.get(key);
  if (alias) {
    return {
      requested: raw,
      kind: 'pin',
      preferredModelId: alias.optionId,
      label: alias.label,
      contextWindow: 200_000,
    };
  }

  if (KNOWN_OPTION_IDS.has(raw)) {
    return {
      requested: raw,
      kind: 'pin',
      preferredModelId: raw,
      label: OPTION_TO_ALIAS.get(raw)?.label ?? raw,
      contextWindow: 200_000,
    };
  }

  if (/^[a-z0-9][a-z0-9._-]{2,}$/i.test(raw) && raw.includes('-')) {
    // Looks like a registry option id we do not have a label for. Send it through
    // as a pin; the server substitutes when the plan cannot serve it.
    return { requested: raw, kind: 'pin', preferredModelId: raw, label: raw, contextWindow: 200_000 };
  }

  return {
    requested: raw || ROOST_TIERS.standard.id,
    kind: 'roost',
    roostModelChoice: 'standard',
    contextWindow: ROOST_TIERS.standard.context,
    label: ROOST_TIERS.standard.label,
  };
}

/** OpenAI /v1/models payload. */
export function listModels() {
  const created = Math.floor(Date.now() / 1000);
  const tiers = Object.values(ROOST_TIERS).map((tier) => ({
    id: tier.id,
    object: 'model',
    created,
    owned_by: 'perch',
    context_window: tier.context,
    display_name: tier.label,
    perch_kind: 'roost',
    perch_tier: tier.tier,
  }));
  const pins = aliases.map((row) => ({
    id: row.alias,
    object: 'model',
    created,
    owned_by: 'perch',
    context_window: 200_000,
    display_name: row.label,
    perch_kind: 'pin',
    perch_option_id: row.optionId,
  }));
  return [...tiers, ...pins];
}
