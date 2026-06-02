// ============================================================================
// Anthropic API pricing configuration.
//
// *** VERIFY RATES BEFORE MAKING PRICING DECISIONS ***
// These rates were verified on 2026-06-02 from:
//   https://platform.claude.com/docs/en/about-claude/pricing
//
// Anthropic changes pricing periodically. Before relying on cost data for
// business decisions, re-verify current rates at the URL above and update
// the constants in this file. The comment date above should be kept current.
//
// All prices are USD per million tokens (MTok).
//
// Cache write prices below apply to the 5-minute ephemeral cache
// (cache_control: { type: "ephemeral" }), which Vulcan uses throughout.
// The 1-hour cache write costs 2x input instead of 1.25x — if you switch to
// 1-hour caching, update cacheWritePerMTok to the values in the "1h" column
// on the pricing page.
// ============================================================================

export const MODEL_PRICING = {
  // Diagnose mode + Smart Diagnose assessment (/api/assess, /api/diagnose)
  "claude-opus-4-6": {
    inputPerMTok:      5.00,   // $5.00/MTok — standard (uncached) input
    cacheWritePerMTok: 6.25,   // $6.25/MTok — 5-minute ephemeral write (1.25× input)
    cacheReadPerMTok:  0.50,   // $0.50/MTok — cache hit / refresh (0.10× input)
    outputPerMTok:    25.00,   // $25.00/MTok
  },

  // Ask Vulcan + DTC fallback (/api/ask, dtcFallback)
  "claude-sonnet-4-6": {
    inputPerMTok:      3.00,
    cacheWritePerMTok: 3.75,
    cacheReadPerMTok:  0.30,
    outputPerMTok:    15.00,
  },

  // Haiku — not currently used in Vulcan but priced here for completeness
  // if a faster/cheaper tier is ever added.
  "claude-haiku-4-5-20251001": {
    inputPerMTok:      1.00,
    cacheWritePerMTok: 1.25,
    cacheReadPerMTok:  0.10,
    outputPerMTok:     5.00,
  },
};

// Sentinel returned for unknown models. Cost fields are -1 so callers can
// detect "pricing unavailable" without crashing.
const UNKNOWN_PRICING = {
  inputPerMTok: -1,
  cacheWritePerMTok: -1,
  cacheReadPerMTok: -1,
  outputPerMTok: -1,
};

export function getPricing(model) {
  return MODEL_PRICING[model] ?? UNKNOWN_PRICING;
}

// Compute the full cost breakdown for one API call.
// usage is the .usage object from the Anthropic SDK response.
// Returns null if the model's pricing is not configured.
export function computeCost(usage, model) {
  const p = getPricing(model);
  if (p.inputPerMTok < 0) {
    console.warn(`[cost-config] Unknown model "${model}" — cost not computable`);
    return null;
  }

  const inputTokens      = usage?.input_tokens                ?? 0;
  const outputTokens     = usage?.output_tokens               ?? 0;
  const cacheWriteTokens = usage?.cache_creation_input_tokens ?? 0;
  const cacheReadTokens  = usage?.cache_read_input_tokens     ?? 0;

  const inputCost      = (inputTokens      / 1_000_000) * p.inputPerMTok;
  const cacheWriteCost = (cacheWriteTokens / 1_000_000) * p.cacheWritePerMTok;
  const cacheReadCost  = (cacheReadTokens  / 1_000_000) * p.cacheReadPerMTok;
  const outputCost     = (outputTokens     / 1_000_000) * p.outputPerMTok;

  return {
    model,
    tokens: {
      input:      inputTokens,
      cacheWrite: cacheWriteTokens,
      cacheRead:  cacheReadTokens,
      output:     outputTokens,
    },
    cost: {
      input:      r6(inputCost),
      cacheWrite: r6(cacheWriteCost),
      cacheRead:  r6(cacheReadCost),
      output:     r6(outputCost),
      total:      r6(inputCost + cacheWriteCost + cacheReadCost + outputCost),
    },
  };
}

// Round to 6 decimal places (sub-cent precision for cost tracking).
function r6(n) {
  return Math.round(n * 1_000_000) / 1_000_000;
}
