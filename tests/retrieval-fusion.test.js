'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
// Missing export becomes a failing behavior assertion during the initial RED run.
let fuseRankings;
try { ({ fuseRankings } = require('../alexandria-mcp/lib/retrieval/fusion')); }
catch (error) { if (error.code !== 'MODULE_NOT_FOUND') throw error; }
function hit(path, rank = 1, rawScore = 1) {
  return { path, title: path, snippet: 'synthetic', metadata: { category: 'concepts' }, rank, rawScore };
}
function fuse(streams, options) {
  assert.equal(typeof fuseRankings, 'function', 'RRF API must be implemented');
  return fuseRankings(streams, options);
}
function near(actual, expected) { assert.ok(Math.abs(actual - expected) < 1e-15, `${actual} != ${expected}`); }

test('score-from-ranks: a rank 1 hit in two streams contributes 2/61', () => {
  const [result] = fuse({ fts: [hit('a.md')], vector: [hit('a.md', 1, null)] });
  near(result.score, 2 / 61);
  assert.deepEqual(result.evidence, [
    { stream: 'fts', rank: 1, contribution: 1 / 61, rawScore: 1 },
    { stream: 'vector', rank: 1, contribution: 1 / 61, rawScore: null },
  ]);
  assert.equal(result.title, 'a.md');
  assert.deepEqual(result.metadata, { category: 'concepts' });
});
test('scale-independent: rawScore magnitude does not affect fusion', () => {
  const first = fuse({ fts: [hit('a.md', 4, -100)], vector: [hit('b.md', 1, 0.001)] });
  const scaled = fuse({ fts: [hit('a.md', 4, 1e20)], vector: [hit('b.md', 1, -1e20)] });
  assert.deepEqual(first.map(({ path, score }) => ({ path, score })), scaled.map(({ path, score }) => ({ path, score })));
});
test('duplicate-once-per-stream: best explicit rank wins without mutating input', () => {
  const streams = { fts: [hit('a.md', 8), hit('a.md', 2), hit('a.md', 4)], graph: [hit('a.md', 3)] };
  const before = structuredClone(streams);
  const [result] = fuse(streams);
  near(result.score, 1 / 62 + 1 / 63);
  assert.deepEqual(result.evidence.map(({ stream, rank }) => [stream, rank]), [['fts', 2], ['graph', 3]]);
  assert.deepEqual(streams, before);
});
test('missing-stream: absent streams and an empty candidate set are valid', () => {
  assert.deepEqual(fuse({}), []);
  assert.deepEqual(fuse({ entity: [] }), []);
  near(fuse({ graph: [hit('a.md', 5)] })[0].score, 1 / 65);
});
test('stable-ties: equal scores sort by path independent of input order', () => {
  assert.deepEqual(fuse({ fts: [hit('z.md'), hit('A.md'), hit('a.md')] }).map(h => h.path), ['A.md', 'a.md', 'z.md']);
  assert.deepEqual(fuse({ fts: [hit('a.md'), hit('z.md'), hit('A.md')] }).map(h => h.path), ['A.md', 'a.md', 'z.md']);
});
test('explicit ranks, weights and k control contribution, not array position', () => {
  const result = fuse({ fts: [hit('a.md', 10), hit('b.md', 2)], vector: [hit('a.md', 1)], entity: [hit('c.md', 1)] }, { k: 10, weights: { fts: 2, vector: 0 } });
  assert.deepEqual(result.map(h => h.path), ['b.md', 'a.md', 'c.md']);
  near(result[0].score, 2 / 12);
  near(result[1].score, 2 / 20);
  assert.equal(result[1].evidence.length, 1);
});
test('limit applies after all streams are fused', () => {
  const streams = { fts: [hit('x.md', 1), hit('shared.md', 2)], vector: [hit('y.md', 1), hit('shared.md', 2)] };
  const [result] = fuse(streams, { limit: 1 });
  assert.equal(result.path, 'shared.md');
  near(result.score, 2 / 62);
  assert.deepEqual(fuse(streams, { limit: 0 }), []);
});
test('unsafe and non-normalized paths are discarded before deduplication', () => {
  const bad = ['', '/a.md', '../a.md', 'x/../a.md', './a.md', 'x//a.md', 'a/', 'C:/a.md', 'a\\b.md', 'x\u0000.md', 'file:///a.md'];
  const result = fuse({ fts: [...bad.map(path => hit(path)), hit('concepts/ação.md')] });
  assert.deepEqual(result.map(h => h.path), ['concepts/ação.md']);
});
test('invalid ranks and raw scores are discarded, including a bad duplicate before a valid hit', () => {
  const invalid = [null, {}, hit('a.md', 0), hit('a.md', -1), hit('a.md', 1.5), hit('a.md', Infinity), hit('a.md', Number.MAX_SAFE_INTEGER + 1), hit('a.md', '1'), hit('a.md', 1, NaN), hit('a.md', 1, Infinity), hit('a.md', 1, '3'), { ...hit('a.md'), rawScore: undefined }];
  const result = fuse({ fts: [...invalid, hit('a.md', 2, null)] });
  assert.equal(result.length, 1);
  near(result[0].score, 1 / 62);
});
test('malformed options fail explicitly instead of creating NaN or silently defaulting', () => {
  for (const options of [null, [], 'bad', { weights: null }, { weights: [] }, { weights: { fts: '1' } }, { k: '60' }, { limit: '1' }]) {
    assert.throws(() => fuse({}, options), TypeError);
  }
  for (const options of [{ k: -1 }, { k: NaN }, { k: Infinity }, { limit: -1 }, { limit: 1.5 }, { limit: Infinity }, { weights: { fts: -1 } }, { weights: { graph: NaN } }, { weights: { entity: Infinity } }]) {
    assert.throws(() => fuse({}, options), RangeError);
  }
});
test('malformed stream containers fail explicitly and unknown streams are ignored', () => {
  for (const streams of [null, [], 'bad', { fts: null }, { vector: {} }]) assert.throws(() => fuse(streams), TypeError);
  assert.deepEqual(fuse({ unknown: [hit('a.md')] }), []);
});
test('overflow in accumulated fusion scores is rejected safely', () => {
  assert.throws(() => fuse({ fts: [hit('a.md')], vector: [hit('a.md')] }, { k: 0, weights: { fts: Number.MAX_VALUE, vector: Number.MAX_VALUE } }), RangeError);
});

test('POSIX-valid paths survive fusion despite Windows reserved names and characters', () => {
  const paths = ['concepts/CON.md', 'concepts/question?.md', 'concepts/name*.md', 'concepts/a|b.md', 'concepts/trailing. ', 'concepts/note:detail.md'];
  const result = fuse({ fts: paths.map(path => hit(path)) });
  assert.deepEqual(result.map(h => h.path), [...paths].sort());
  assert.equal(result.length, 6);
});
