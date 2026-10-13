'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { createIndexSync } = require('../alexandria-mcp/lib/index-sync');
async function setup(t, options = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'index-sync-'));
  const calls = [], failures = [], watcher = new EventEmitter();
  watcher.close = () => { watcher.closed = true; };
  let emit;
  const sync = createIndexSync({ vaultDir: dir, debounceMs: 5, reconcileMs: 0,
    onUpsert: async p => calls.push(['upsert', p]), onDelete: async p => calls.push(['delete', p]),
    onFailure: (p, e) => failures.push([p, e]), watcherFactory: (_dir, _opts, cb) => { emit = cb; return watcher; }, ...options });
  t.after(async () => { await sync.close(); await fs.rm(dir, { recursive: true, force: true }); });
  return { dir, calls, failures, watcher, sync, emit: (...args) => emit(...args), write: (p, text) => fs.writeFile(path.join(dir, p), text) };
}
test('same-size-edit and burst-debounce only update affected paths', async t => {
  const f = await setup(t); await f.write('a.md', 'one'); await f.write('b.md', 'two'); await f.sync.start(); f.calls.length = 0;
  await f.write('a.md', 'new'); for (let i = 0; i < 10; i++) f.sync.markDirty('a.md'); await f.sync.flush();
  assert.deepEqual(f.calls, [['upsert', 'a.md']]); await f.sync.flush(); assert.equal(f.calls.length, 1);
});
test('rename-delete and seeded offline deletion reconcile on awaited start', async t => {
  const f = await setup(t, { initialPaths: ['offline.md'] }); await f.write('old.md', 'x'); await f.sync.start();
  assert.ok(f.calls.some(c => c[0] === 'delete' && c[1] === 'offline.md')); f.calls.length = 0;
  await fs.rename(path.join(f.dir, 'old.md'), path.join(f.dir, 'new.md')); f.emit('rename', 'old.md'); await f.sync.flush();
  assert.deepEqual(f.calls.sort(), [['delete', 'old.md'], ['upsert', 'new.md']]);
});
test('partial-walk-preserves-index including seeded entries', async t => {
  let fail = false;
  const io = { ...fs, readdir: async (...args) => { if (fail) throw Object.assign(new Error('partial walk'), { code: 'EACCES' }); return fs.readdir(...args); } };
  const f = await setup(t, { fsPromises: io, initialPaths: ['offline.md'] }); fail = true;
  await assert.rejects(f.sync.start(), /partial walk/); assert.deepEqual(f.calls, []);
  fail = false; await f.sync.reconcile(); assert.deepEqual(f.calls, [['delete', 'offline.md']]);
});
test('watcher-overflow-reconciles and missing filename discovers new directories', async t => {
  const f = await setup(t); await f.sync.start(); await fs.mkdir(path.join(f.dir, 'new')); await f.write('new/n.md', 'x');
  f.watcher.emit('error', new Error('overflow')); await f.sync.flush(); assert.deepEqual(f.calls, [['upsert', 'new/n.md']]);
  await f.write('late.md', 'x'); f.emit('rename', null); await f.sync.flush(); assert.ok(f.calls.some(c => c[1] === 'late.md'));
});
test('outside-vault-rejected and hidden/archive/temp paths excluded', async t => {
  const f = await setup(t); await f.sync.start();
  for (const p of ['../escape.md', '/escape.md', 'a/../escape.md', 'C:\\escape.md']) assert.throws(() => f.sync.markDirty(p), /relative|unsafe/);
  for (const dir of ['.hidden', '_archive']) { await fs.mkdir(path.join(f.dir, dir)); await f.write(dir + '/a.md', 'x'); }
  await f.write('temp.md.tmp', 'x'); await f.sync.reconcile(); assert.deepEqual(f.calls, []);
});
test('inflight changes converge and flush callbacks remain serial', async t => {
  let f, count = 0, active = 0, max = 0;
  f = await setup(t, { onUpsert: async p => { active++; max = Math.max(max, active); count++; if (count === 1) { await f.write(p, 'changed'); f.sync.markDirty(p); } await new Promise(r => setTimeout(r, 10)); active--; } });
  await f.sync.start(); await f.write('a.md', 'initial'); f.sync.markDirty('a.md'); await Promise.all([f.sync.flush(), f.sync.reconcile()]);
  assert.equal(count, 2); assert.equal(max, 1);
});
test('close drains work, closes watcher, and rejects later mutations', async t => {
  const f = await setup(t); await f.sync.start(); await f.write('a.md', 'x'); f.sync.markDirty('a.md'); await f.sync.close();
  assert.deepEqual(f.calls, [['upsert', 'a.md']]); assert.equal(f.watcher.closed, true); assert.throws(() => f.sync.markDirty('a.md'), /closed/);
});

test('deletion event cannot remove index while parent is unreadable', async t => {
  let deny = false;
  const io = { ...fs, readdir: async (...args) => { if (deny) throw Object.assign(new Error('parent inaccessible'), { code: 'EACCES' }); return fs.readdir(...args); } };
  const f = await setup(t, { fsPromises: io }); await f.write('a.md', 'x'); await f.sync.start(); f.calls.length = 0;
  await fs.unlink(path.join(f.dir, 'a.md')); deny = true; f.sync.markDirty('a.md'); await assert.rejects(f.sync.flush(), /parent inaccessible/);
  assert.deepEqual(f.calls, []); deny = false; await f.sync.flush(); assert.deepEqual(f.calls, [['delete', 'a.md']]);
});
test('symlinks to outside vault are never read or indexed', async t => {
  const f = await setup(t); const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'index-sync-outside-'));
  t.after(() => fs.rm(outside, { recursive: true, force: true })); await fs.writeFile(path.join(outside, 'secret.md'), 'do not read');
  try { await fs.symlink(outside, path.join(f.dir, 'link'), process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (error) { if (error.code === 'EPERM') return t.skip('symlink permission unavailable'); throw error; }
  await f.sync.start(); assert.deepEqual(f.calls, []); f.sync.markDirty('link/secret.md'); await assert.rejects(f.sync.flush(), /symlink/);
  assert.deepEqual(f.calls, []); await fs.unlink(path.join(f.dir, 'link')); await f.sync.flush();
});
test('native recursive watcher converges after a file change', async t => {
  const f = await setup(t, { watcherFactory: require('node:fs').watch }); await f.sync.start(); await f.write('a.md', 'native');
  const deadline = Date.now() + 3000;
  while (!f.calls.length && Date.now() < deadline) await new Promise(r => setTimeout(r, 20));
  assert.deepEqual(f.calls, [['upsert', 'a.md']]);
});
test('failed initial enumeration can be retried through flush without index loss', async t => {
  let deny = true;
  const io = { ...fs, readdir: async (...args) => { if (deny) throw new Error('enumeration unavailable'); return fs.readdir(...args); } };
  const f = await setup(t, { fsPromises: io, initialPaths: ['gone.md'] });
  await assert.rejects(f.sync.start(), /enumeration unavailable/); assert.deepEqual(f.calls, []); deny = false;
  await f.sync.flush(); assert.deepEqual(f.calls, [['delete', 'gone.md']]);
});


test('partially enumerated nested tree preserves all seeded entries', async t => {
  let deny = false;
  const io = { ...fs, readdir: async (dir, ...args) => { if (deny && path.basename(dir) === 'blocked') throw new Error('nested walk incomplete'); return fs.readdir(dir, ...args); } };
  const f = await setup(t, { fsPromises: io, initialPaths: ['gone.md', 'blocked/old.md'] });
  await fs.mkdir(path.join(f.dir, 'blocked')); await f.write('first.md', 'x'); deny = true;
  await assert.rejects(f.sync.start(), /nested walk incomplete/); assert.deepEqual(f.calls, []);
  assert.equal(f.failures[0][0], ''); deny = false; await f.sync.flush();
  assert.deepEqual(f.calls.sort(), [['delete', 'blocked/old.md'], ['delete', 'gone.md'], ['upsert', 'first.md']]);
});
test('callback failure reports relative path and is retryable', async t => {
  let fail = true;
  const f = await setup(t, { onUpsert: async p => { if (fail) throw new Error('index transaction failed'); f.calls.push(['upsert', p]); } });
  await f.sync.start(); await f.write('a.md', 'x'); f.sync.markDirty('a.md');
  await assert.rejects(f.sync.flush(), /index transaction failed/); assert.equal(f.failures[0][0], 'a.md');
  fail = false; await f.sync.flush(); assert.deepEqual(f.calls, [['upsert', 'a.md']]);
});

test('scan revalidates later note after earlier callback swaps directory to junction', async t => {
  let f; const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'index-sync-race-'));
  t.after(() => fs.rm(outside, { recursive: true, force: true })); await fs.writeFile(path.join(outside, 'b.md'), 'OUTSIDE CONTENT');
  f = await setup(t, { onUpsert: async (p, metadata) => {
    f.calls.push([p, metadata.content]);
    if (p === 'a.md') { await fs.rm(path.join(f.dir, 'sub'), { recursive: true }); await fs.symlink(outside, path.join(f.dir, 'sub'), process.platform === 'win32' ? 'junction' : 'dir'); }
  } });
  await f.write('a.md', 'inside'); await fs.mkdir(path.join(f.dir, 'sub')); await f.write('sub/b.md', 'inside-b');
  await assert.rejects(f.sync.start(), /symlink/); assert.deepEqual(f.calls, [['a.md', 'inside']]);
  await fs.unlink(path.join(f.dir, 'sub')); await f.sync.flush();
});
test('missing note recreated during parent access is upserted instead of deleted', async t => {
  let f, recreate = false;
  const io = { ...fs, readdir: async (...args) => { if (recreate) { recreate = false; await f.write('a.md', 'recreated'); } return fs.readdir(...args); } };
  f = await setup(t, { fsPromises: io }); await f.write('a.md', 'original'); await f.sync.start(); f.calls.length = 0;
  await fs.unlink(path.join(f.dir, 'a.md')); recreate = true; f.sync.markDirty('a.md'); await f.sync.flush();
  assert.deepEqual(f.calls, [['upsert', 'a.md']]);
});

test('injected I/O revalidates enumerated paths before any later note read', async t => {
  let unsafe = false; const reads = [];
  const io = { ...fs,
    lstat: async target => { if (unsafe && path.basename(target) === 'sub') return { isSymbolicLink: () => true }; return fs.lstat(target); },
    readFile: async target => { reads.push(target); return fs.readFile(target); },
    readdir: async (...args) => { const entries = await fs.readdir(...args); return entries.sort((a, b) => String(a.name || a).localeCompare(String(b.name || b))); }
  };
  const f = await setup(t, { fsPromises: io, onUpsert: async p => { f.calls.push(['upsert', p]); if (p === 'a.md') unsafe = true; } });
  await f.write('a.md', 'inside'); await fs.mkdir(path.join(f.dir, 'sub')); await f.write('sub/b.md', 'inside-b');
  await assert.rejects(f.sync.start(), /symlink/); assert.ok(reads.every(target => path.basename(target) !== 'b.md'));
  assert.deepEqual(f.calls, [['upsert', 'a.md']]); unsafe = false; await f.sync.flush();
});
