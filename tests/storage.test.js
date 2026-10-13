'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { DatabaseSync } = require('node:sqlite');
const { openStore } = require('../alexandria-mcp/lib/storage');

const resources = new Map();
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'alexandria-storage-'));
  const dbPath = path.join(dir, 'index.db');
  resources.set(dbPath, []);
  t.after(() => {
    for (const store of resources.get(dbPath)) store.close();
    resources.delete(dbPath);
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return dbPath;
}
function connect(t, dbPath) {
  const store = openStore({ dbPath });
  resources.get(dbPath).push(store);
  return store;
}
function paths(store) { return store.all('SELECT path FROM pages ORDER BY path').map(row => row.path); }

test('persistent-connection: temporary state survives calls; parameters preserve hostile text', t => {
  const store = connect(t, fixture(t));
  store.exec('CREATE TEMP TABLE scratch(value TEXT); CREATE TABLE extra(value TEXT);');
  const value = "quote'); DROP TABLE pages; --";
  store.exec('INSERT INTO scratch VALUES (?)', [value]);
  assert.equal(store.all('SELECT value FROM scratch WHERE value = ?', [value])[0].value, value);
  assert.equal(store.all('PRAGMA busy_timeout')[0].timeout, 5000);
  assert.equal(store.all('PRAGMA journal_mode')[0].journal_mode, 'wal');
  assert.throws(() => store.all('SELECT * FROM missing_table'), /no such table/);
  assert.throws(() => store.exec('INSERT INTO missing_table VALUES (?)', [value]), /no such table/);
});

test('rollback-on-error preserves previous rows and transaction returns callback value', t => {
  const store = connect(t, fixture(t));
  store.exec('INSERT INTO pages(path) VALUES (?)', ['prior.md']);
  assert.throws(() => store.transaction(() => {
    store.exec('INSERT INTO pages(path) VALUES (?)', ['lost.md']);
    throw new Error('abort synthetic write');
  }), /abort synthetic write/);
  assert.deepEqual(paths(store), ['prior.md']);
  assert.equal(store.transaction(() => {
    store.exec('INSERT INTO pages(path) VALUES (?)', ['kept.md']);
    return 42;
  }), 42);
  assert.deepEqual(paths(store), ['kept.md', 'prior.md']);
});

test('reject nested and asynchronous transactions without leaking writes', t => {
  const store = connect(t, fixture(t));
  assert.throws(() => store.transaction(() => {
    store.exec('INSERT INTO pages(path) VALUES (?)', ['nested.md']);
    store.transaction(() => {});
  }), /nested/i);
  assert.throws(() => store.transaction(() => {
    store.exec('INSERT INTO pages(path) VALUES (?)', ['promise.md']);
    return Promise.resolve(1);
  }), /synchronous|promise/i);
  assert.throws(() => store.transaction(async () => {}), /synchronous|async/i);
  assert.deepEqual(paths(store), []);
  assert.equal(store.transaction(() => 'ready'), 'ready');
});

test('close-and-reopen persists data, releases handles, and rejects use after close', t => {
  const dbPath = fixture(t);
  const store = connect(t, dbPath);
  store.exec('INSERT INTO pages(path,title) VALUES (?,?)', ['kept.md', 'Persisted']);
  store.close(); store.close();
  assert.throws(() => store.all('SELECT 1'), /closed/i);
  assert.throws(() => store.exec('SELECT 1'), /closed/i);
  assert.throws(() => store.transaction(() => {}), /closed/i);
  const reopened = connect(t, dbPath);
  assert.equal(reopened.all('SELECT title FROM pages')[0].title, 'Persisted');
  assert.equal(reopened.all('PRAGMA integrity_check')[0].integrity_check, 'ok');
});

function legacy(dbPath) {
  const db = new DatabaseSync(dbPath);
  db.exec(`CREATE TABLE pages(path TEXT PRIMARY KEY, title TEXT, category TEXT, content TEXT,
    summary TEXT, modified TEXT, links INTEGER DEFAULT 0, custom TEXT);
    CREATE VIRTUAL TABLE pages_fts USING fts5(path UNINDEXED,title,category,content,summary);
    CREATE TABLE embeddings(path TEXT PRIMARY KEY,vector TEXT, custom_embedding TEXT);
    CREATE TABLE observations(id TEXT PRIMARY KEY,path TEXT,title TEXT,category TEXT,content TEXT,
      tags TEXT,context TEXT,permalink TEXT,modified TEXT);
    CREATE TABLE relations(id TEXT PRIMARY KEY,path TEXT,title TEXT,relation_type TEXT,target TEXT,
      context TEXT,permalink TEXT,modified TEXT);
    INSERT INTO pages VALUES ('old.md','Old','projects','durable SQLite memory','summary','2026-01-01',2,'custom survives');
    INSERT INTO pages_fts VALUES ('old.md','Old','projects','durable SQLite memory','summary');
    INSERT INTO embeddings VALUES ('old.md','[0.1,0.2]','keep');
    INSERT INTO observations(id,path,content) VALUES ('ob1','old.md','decision survives');
    INSERT INTO relations(id,path,target) VALUES ('rel1','old.md','target.md');`);
  db.close();
}

test('migration-idempotent upgrades legacy DB without removing custom columns or data', t => {
  const dbPath = fixture(t); legacy(dbPath);
  for (let attempt = 0; attempt < 2; attempt++) {
    const store = connect(t, dbPath);
    assert.deepEqual(paths(store), ['old.md']);
    assert.equal(store.all('SELECT custom FROM pages')[0].custom, 'custom survives');
    assert.equal(store.all('SELECT custom_embedding FROM embeddings')[0].custom_embedding, 'keep');
    assert.equal(store.all('SELECT content FROM observations')[0].content, 'decision survives');
    assert.equal(store.all('SELECT target FROM relations')[0].target, 'target.md');
    const columns = new Set(store.all('PRAGMA table_info(pages)').map(row => row.name));
    for (const column of ['permalink','note_type','tags','metadata','checksum','size']) assert.ok(columns.has(column), column);
    assert.equal(store.all('PRAGMA integrity_check')[0].integrity_check, 'ok');
    store.close();
  }
});

test('fts5-preserved supports search in fresh and legacy databases after reopen', t => {
  for (const old of [false, true]) {
    const dbPath = fixture(t);
    if (old) legacy(dbPath);
    const store = connect(t, dbPath);
    if (!old) store.exec('INSERT INTO pages_fts(path,title,content) VALUES (?,?,?)', ['old.md','Old','durable SQLite memory']);
    assert.equal(store.all('SELECT path FROM pages_fts WHERE pages_fts MATCH ?', ['durable'])[0].path, 'old.md');
    store.close();
    const reopened = connect(t, dbPath);
    assert.equal(reopened.all('SELECT path FROM pages_fts WHERE pages_fts MATCH ?', ['durable'])[0].path, 'old.md');
  }
});

test('failed legacy migration is atomic and releases database connection', t => {
  const dbPath = fixture(t);
  const db = new DatabaseSync(dbPath);
  db.exec("CREATE TABLE pages(path TEXT PRIMARY KEY); INSERT INTO pages VALUES ('safe.md'); CREATE VIEW observations AS SELECT path AS id,path FROM pages;");
  db.close();
  assert.throws(() => openStore({ dbPath }), /view|already exists/i);
  const check = new DatabaseSync(dbPath);
  try {
    assert.deepEqual(check.prepare('PRAGMA table_info(pages)').all().map(row => row.name), ['path']);
    assert.equal(check.prepare('SELECT path FROM pages').get().path, 'safe.md');
    assert.equal(check.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name='pages_fts'").get().n, 0);
    check.exec('DROP VIEW observations;');
  } finally { check.close(); }
  const store = connect(t, dbPath);
  assert.deepEqual(paths(store), ['safe.md']);
});

test('concurrent-process-lock exposes lock failure and WAL readers keep committed data', { timeout: 20000 }, async t => {
  const dbPath = fixture(t);
  const store = connect(t, dbPath);
  store.exec('INSERT INTO pages(path) VALUES (?)', ['prior.md']);
  const modulePath = path.resolve(__dirname, '../alexandria-mcp/lib/storage.js');
  const child = spawn(process.execPath, ['-e', `
    const {openStore}=require(${JSON.stringify(modulePath)});
    const store=openStore({dbPath:${JSON.stringify(dbPath)}});
    store.transaction(()=>{
      store.exec('INSERT INTO pages(path) VALUES (?)',['child.md']);
      process.stdout.write('LOCKED\\n');
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,7500);
    });
    store.close();
  `], { stdio: ['ignore','pipe','pipe'] });
  let stderr = ''; child.stderr.on('data', data => { stderr += data; });
  const exited = once(child, 'exit');
  t.after(() => { if (child.exitCode === null) child.kill(); });
  await new Promise((resolve, reject) => {
    child.stdout.once('data', data => data.toString().includes('LOCKED') ? resolve() : reject(new Error('unexpected child output')));
    child.once('error', reject);
    child.once('exit', code => reject(new Error(`child exited before lock (${code}): ${stderr}`)));
  });
  assert.deepEqual(paths(store), ['prior.md']);
  const started = Date.now();
  assert.throws(() => store.exec('INSERT INTO pages(path) VALUES (?)', ['blocked.md']), error => {
    assert.match(error.message, /locked|busy/i);
    assert.equal(error.code, 'ERR_SQLITE_ERROR');
    return true;
  });
  assert.ok(Date.now() - started >= 4500, 'configured busy timeout waits before failing');
  const [code] = await exited;
  assert.equal(code, 0, stderr);
  assert.deepEqual(paths(store), ['child.md','prior.md']);
  store.exec('INSERT INTO pages(path) VALUES (?)', ['after.md']);
  assert.equal(store.all('PRAGMA integrity_check')[0].integrity_check, 'ok');
});
