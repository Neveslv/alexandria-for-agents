'use strict';

// Independent JavaScript implementation of Reciprocal Rank Fusion (RRF).
// Algorithm: Cormack, Clarke and Buettcher, SIGIR 2009, pp. 758-759.
// https://doi.org/10.1145/1571941.1572114
// https://cormack.uwaterloo.ca/cormacksigir09-rrf.pdf
// We extend the paper's sum(1 / (k + rank)) with per-stream weights.
// Scores are ranking signals, never probabilities of relevance.
const STREAMS = Object.freeze(['fts', 'vector', 'entity', 'graph']);
const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);

function nonnegativeNumber(value, name) {
  if (typeof value !== 'number') throw new TypeError(`${name} must be a number`);
  if (!Number.isFinite(value) || value < 0) throw new RangeError(`${name} must be finite and nonnegative`);
  return value;
}

function validPath(path) {
  if (typeof path !== 'string' || !path || /[\\\x00]/.test(path) || /^[a-z]:\//i.test(path)) return false;
  return path.split('/').every(segment => segment && segment !== '.' && segment !== '..');
}
function validHit(hit) {
  return record(hit) && validPath(hit.path) && Number.isSafeInteger(hit.rank) && hit.rank > 0
    && (hit.rawScore === null || (typeof hit.rawScore === 'number' && Number.isFinite(hit.rawScore)));
}

/**
 * Fuse ranked streams without mutating candidates or options.
 * Missing streams are empty; malformed containers/options throw explicitly.
 * Invalid hit records are skipped. Each path contributes its best valid rank
 * once per stream. Candidate fields come from the first contributing stream
 * (fts, vector, entity, graph); tied duplicate ranks retain the first record.
 * Zero-weight streams contribute no hits/evidence. Ties use code-unit path order.
 */
function fuseRankings(streams, options = {}) {
  if (!record(streams)) throw new TypeError('streams must be an object');
  if (!record(options)) throw new TypeError('options must be an object');
  const k = nonnegativeNumber(own(options, 'k') ? options.k : 60, 'k');
  let limit;
  if (own(options, 'limit')) {
    limit = nonnegativeNumber(options.limit, 'limit');
    if (!Number.isSafeInteger(limit)) throw new RangeError('limit must be a safe integer');
  }
  const weights = own(options, 'weights') ? options.weights : {};
  if (!record(weights)) throw new TypeError('weights must be an object');
  const validatedWeights = {};
  for (const stream of STREAMS) {
    validatedWeights[stream] = nonnegativeNumber(own(weights, stream) ? weights[stream] : 1, `weights.${stream}`);
    if (own(streams, stream) && !Array.isArray(streams[stream])) throw new TypeError(`${stream} must be an array`);
  }

  const fused = new Map();
  for (const stream of STREAMS) {
    const weight = validatedWeights[stream];
    if (weight === 0 || !own(streams, stream)) continue;
    const unique = new Map();
    for (const hit of streams[stream]) {
      if (!validHit(hit)) continue;
      const existing = unique.get(hit.path);
      if (!existing || hit.rank < existing.rank) unique.set(hit.path, hit);
    }
    for (const hit of unique.values()) {
      const contribution = weight / (k + hit.rank);
      let result = fused.get(hit.path);
      if (!result) {
        result = { path: hit.path, title: hit.title, snippet: hit.snippet, metadata: hit.metadata, score: 0, evidence: [] };
        fused.set(hit.path, result);
      }
      const score = result.score + contribution;
      if (!Number.isFinite(score)) throw new RangeError('fusion score exceeds finite number range');
      result.score = score;
      result.evidence.push({ stream, rank: hit.rank, contribution, rawScore: hit.rawScore });
    }
  }
  const results = [...fused.values()].sort((a, b) => b.score - a.score || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return limit === undefined ? results : results.slice(0, limit);
}

module.exports = { fuseRankings };
