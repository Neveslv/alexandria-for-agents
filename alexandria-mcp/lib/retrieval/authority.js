'use strict';

// Bounded evaluation candidates, not validated retrieval-quality claims.
// Activation and query-intent classification belong to the integration gate.
const DEFAULT_WEIGHTS = Object.freeze({ current: 1.10, superseded: 0.85, canonical: 1.10, maintained: 1.05 });
const MIN_FACTOR = 0.55;
const MAX_FACTOR = 1.50;
const clamp = value => Math.max(MIN_FACTOR, Math.min(MAX_FACTOR, value));
const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key);

/**
 * Pure authority stage for FusedHit[]. Only direct frontmatter metadata counts.
 * weights are multiplicative factors named current/superseded/canonical/maintained.
 * Every finite factor and the combined factor are clamped to [0.55, 1.50].
 * Historical intent bypasses all weighting and preserves incoming order/scores.
 * Neutral (default) applies canonical/maintained only; current also uses status.
 * Copies hits; metadata/evidence are retained untouched, including all candidates.
 */
function applyAuthority(hits, { queryIntent = 'neutral', weights = {} } = {}) {
  if (queryIntent === 'historical') return hits.map(hit => ({ ...hit }));
  const factors = {};
  for (const [key, fallback] of Object.entries(DEFAULT_WEIGHTS)) {
    const value = weights && own(weights, key) ? weights[key] : undefined;
    factors[key] = Number.isFinite(value) ? clamp(value) : fallback;
  }
  return hits.map((hit, index) => {
    const metadata = hit.metadata;
    let factor = 1;
    if (metadata && typeof metadata === 'object' && !Array.isArray(metadata)) {
      if (queryIntent === 'current' && own(metadata, 'status')) {
        if (metadata.status === 'current') factor *= factors.current;
        else if (metadata.status === 'superseded') factor *= factors.superseded;
      }
      for (const key of ['canonical', 'maintained']) {
        if (own(metadata, key) && (metadata[key] === true || metadata[key] === 'true')) factor *= factors[key];
      }
    }
    return { hit: { ...hit, score: hit.score * clamp(factor) }, index };
  }).sort((a, b) => b.hit.score - a.hit.score || a.index - b.index)
    .map(({ hit }) => hit);
}

module.exports = { applyAuthority, DEFAULT_WEIGHTS, MIN_FACTOR, MAX_FACTOR };
