'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { applyAuthority } = require('../alexandria-mcp/lib/retrieval/authority');
function hit(path, score, metadata = {}) {
  return { path, title: path, snippet: 'synthetic', metadata, score,
    evidence: [{ stream: 'fts', rank: 1, contribution: score, rawScore: null }] };
}
test('bounded-promotion caps combined explicit metadata at 1.50', () => {
  assert.equal(typeof applyAuthority, 'function', 'applyAuthority must be implemented');
  const [result] = applyAuthority([hit('a.md', 2, { status: 'current', canonical: true, maintained: 'true' })],
    { queryIntent: 'current', weights: { current: 10, canonical: 10, maintained: 10 } });
  assert.equal(result.score, 3);
});
test('bounded-demotion floors superseded metadata at 0.55', () => {
  const [result] = applyAuthority([hit('old.md', 2, { status: 'superseded' })],
    { queryIntent: 'current', weights: { superseded: -20 } });
  assert.equal(result.score, 1.1);
});
test('history-not-hidden preserves historical ranking despite current authority', () => {
  const hits = [hit('old.md', 1, { status: 'superseded' }),
    hit('now.md', 0.99, { status: 'current', canonical: true, maintained: true })];
  const result = applyAuthority(hits, { queryIntent: 'historical' });
  assert.deepEqual(result, hits);
  assert.notEqual(result, hits);
});
test('missing-metadata-neutral never infers authority from folder or age', () => {
  const hits = [hit('sessions/old.md', 1), hit('concepts/new.md', 0.9, { updated: '2099-01-01' })];
  delete hits[0].metadata;
  assert.deepEqual(applyAuthority(hits, { queryIntent: 'current' }), hits);
});
test('two-required-notes-preserved keeps both paths and complete evidence', () => {
  const hits = [hit('old.md', 0.5, { status: 'superseded' }), hit('now.md', 0.5, { status: 'current' })];
  hits[0].evidence.push({ stream: 'graph', rank: 2, contribution: 0.1, rawScore: 7 });
  const result = applyAuthority(hits, { queryIntent: 'current' });
  assert.deepEqual(result.map(item => item.path), ['now.md', 'old.md']);
  for (const original of hits) assert.equal(result.find(item => item.path === original.path).evidence, original.evidence);
});
test('explicit current metadata can reorder close scores with configurable weights', () => {
  const result = applyAuthority([hit('plain.md', 1), hit('current.md', 0.95, { status: 'current' })],
    { queryIntent: 'current', weights: { current: 1.2 } });
  assert.deepEqual(result.map(item => item.path), ['current.md', 'plain.md']);
  assert.equal(result[0].score, 1.14);
});
test('neutral intent does not penalize superseded or favor current status', () => {
  const hits = [hit('old.md', 1, { status: 'superseded' }), hit('now.md', 0.99, { status: 'current' })];
  assert.deepEqual(applyAuthority(hits), hits);
});
test('canonical and maintained authority requires explicit true metadata', () => {
  const result = applyAuthority([hit('explicit.md', 1, { canonical: 'true', maintained: true }),
    hit('vague.md', 1, { canonical: 'yes', maintained: 'false' })],
    { weights: { canonical: 1.2, maintained: 1.1 } });
  assert.equal(result[0].score, 1.32);
  assert.equal(result[1].score, 1);
});
test('stable ties preserve incoming order including zero scores', () => {
  const hits = [hit('z.md', 0, { canonical: true }), hit('a.md', 0), hit('m.md', 0)];
  assert.deepEqual(applyAuthority(hits).map(item => item.path), ['z.md', 'a.md', 'm.md']);
});
test('input hits metadata and evidence remain unchanged and frozen inputs work', () => {
  const input = hit('a.md', 1, { status: 'current' });
  Object.freeze(input.metadata); Object.freeze(input.evidence); Object.freeze(input);
  const hits = Object.freeze([input]);
  const [result] = applyAuthority(hits, { queryIntent: 'current', weights: { current: 1.2 } });
  assert.equal(input.score, 1);
  assert.equal(result.score, 1.2);
  assert.notEqual(result, input);
  assert.equal(result.metadata, input.metadata);
});
test('invalid nonfinite or nonnumeric weights use bounded defaults', () => {
  const hits = [hit('a.md', 1, { canonical: true })];
  for (const canonical of [NaN, Infinity, -Infinity, '1.5', null]) {
    assert.deepEqual(applyAuthority(hits, { weights: { canonical } }), applyAuthority(hits));
  }
});
test('ablation setting all weights to one leaves sorted fused scores intact', () => {
  const hits = [hit('a.md', 1, { status: 'superseded' }), hit('b.md', 0.9, { status: 'current', canonical: true })];
  assert.deepEqual(applyAuthority(hits, { queryIntent: 'current',
    weights: { current: 1, superseded: 1, canonical: 1, maintained: 1 } }), hits);
});
test('empty candidate list remains empty', () => { assert.deepEqual(applyAuthority([]), []); });
