'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

/** Incremental, serialized Markdown synchronization. Callbacks receive vault-relative slash paths.
 * start() installs the watcher before awaiting initial reconciliation. onUpsert's optional
 * second argument contains the content and SHA-256 read by this synchronizer.
 */
function createIndexSync({ vaultDir, onUpsert, onDelete, onFailure = () => {},
  debounceMs = 200, reconcileMs = 300000, initialPaths = [],
  watcherFactory = fs.watch, fsPromises = fs.promises } = {}) {
  if (!vaultDir || typeof onUpsert !== 'function' || typeof onDelete !== 'function') throw new TypeError('vaultDir, onUpsert and onDelete are required');
  const root = path.resolve(vaultDir), io = fsPromises;
  const known = new Map(), dirty = new Set();
  let scan = false, started = false, closed = false, closing = false;
  let watcher, timer, periodic, startPromise, closePromise, tail = Promise.resolve();
  function normalize(value) {
    if (typeof value !== 'string' || !value || path.isAbsolute(value) || /^[A-Za-z]:/.test(value)) throw new Error('Expected safe relative path');
    const normalized = value.replace(/\\/g, '/');
    if (normalized.split('/').some(p => !p || p === '..' || p === '.') || normalized.includes('\0')) throw new Error('Unsafe relative path');
    return normalized;
  }
  function included(p) { return !p.split('/').some(segment => segment.startsWith('.') || segment === '_archive'); }
  function note(p) { return included(p) && p.toLowerCase().endsWith('.md'); }
  for (const p of initialPaths) { const rel = normalize(p); if (note(rel)) known.set(rel, null); }
  function failure(error, relativePath = '') { try { onFailure(relativePath, error); } catch { /* Observability must not break synchronization. */ } }
  function enqueue(operation) {
    const result = tail.then(operation).catch(error => { failure(error, error.indexSyncPath || ''); throw error; });
    tail = result.catch(() => {});
    return result;
  }
  function schedule() {
    if (closed || closing || timer) return;
    timer = setTimeout(() => { timer = undefined; flush().catch(() => {}); }, debounceMs);
    timer.unref?.();
  }
  function markDirty(value) {
    if (closed || closing) throw new Error('Index sync is closed');
    const rel = normalize(value);
    if (included(rel)) { dirty.add(rel); schedule(); }
  }
  // Never follow a symlink, including an ancestor of a specifically queued note.
  async function safeStat(rel) {
    let absolute = root;
    for (const segment of rel.split('/')) {
      absolute = path.join(absolute, segment);
      const stat = await io.lstat(absolute);
      if (stat.isSymbolicLink()) throw new Error('Unsafe symlink path: ' + rel);
    }
    return io.lstat(absolute);
  }
  async function enumerate() {
    const found = new Set();
    async function walk(directory, prefix = '') {
      const entries = await io.readdir(directory, { withFileTypes: true });
      for (const entry of entries) {
        const rel = prefix ? prefix + '/' + entry.name : entry.name;
        if (!included(rel) || entry.isSymbolicLink()) continue;
        // Recheck rather than trusting stale Dirent type information.
        const stat = await safeStat(rel);
        if (stat.isDirectory()) await walk(path.join(root, rel), rel);
        else if (stat.isFile() && note(rel)) found.add(rel);
      }
    }
    await walk(root);
    return found;
  }
  async function upsert(rel) {
    const stat = await safeStat(rel);
    if (!stat.isFile()) throw new Error('Expected regular note file: ' + rel);
    const bytes = await io.readFile(path.join(root, rel));
    const hash = crypto.createHash('sha256').update(bytes).digest('hex');
    if (known.has(rel) && known.get(rel) === hash) return;
    await onUpsert(rel, { content: bytes.toString('utf8'), hash });
    known.set(rel, hash);
    // A callback can take long enough for another edit to land, even if no event arrives.
    try {
      await safeStat(rel);
      const after = await io.readFile(path.join(root, rel));
      if (crypto.createHash('sha256').update(after).digest('hex') !== hash) dirty.add(rel);
    } catch (error) { if (error.code === 'ENOENT') dirty.add(rel); else throw error; }
  }
  async function remove(rel) { await onDelete(rel); known.delete(rel); }
  async function processPath(rel) {
    let stat;
    try { stat = await safeStat(rel); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      // A missing filename is insufficient: verify access to its parent before deletion.
      const parent = path.posix.dirname(rel);
      try {
        if (parent !== '.') await safeStat(parent);
        const entries = await io.readdir(parent === '.' ? root : path.join(root, parent));
        if (entries.includes(path.posix.basename(rel))) { dirty.add(rel); return; }
      } catch (parentError) { if (parentError.code === 'ENOENT') { scan = true; return; } throw parentError; }
      if (known.has(rel)) await remove(rel);
      return;
    }
    if (stat.isDirectory()) { scan = true; return; }
    if (stat.isFile() && note(rel)) await upsert(rel);
  }
  async function scanAll() {
    // Crucial: enumerate to completion before any callback or deletion of seeded entries.
    const found = await enumerate();
    for (const rel of found) { try { await upsert(rel); } catch (error) { error.indexSyncPath = rel; throw error; } }
    for (const rel of [...known.keys()]) if (!found.has(rel)) { try { await remove(rel); } catch (error) { error.indexSyncPath = rel; throw error; } }
  }
  async function drain() {
    while (scan || dirty.size) {
      if (scan) { scan = false; try { await scanAll(); } catch (error) { scan = true; throw error; } }
      const batch = [...dirty]; dirty.clear();
      for (let i = 0; i < batch.length; i++) {
        try { await processPath(batch[i]); }
        catch (error) { error.indexSyncPath = batch[i]; for (const rel of batch.slice(i)) dirty.add(rel); throw error; }
      }
    }
  }
  function flush() {
    if (closed) return Promise.reject(new Error('Index sync is closed'));
    clearTimeout(timer); timer = undefined;
    return enqueue(drain);
  }
  function reconcile() {
    if (closed || closing) return Promise.reject(new Error('Index sync is closed'));
    return enqueue(async () => { scan = true; await drain(); });
  }
  function start() {
    if (closed || closing) return Promise.reject(new Error('Index sync is closed'));
    if (started) return startPromise;
    started = true;
    try {
      watcher = watcherFactory(root, { recursive: true }, (event, filename) => {
        if (closed || closing) return;
        // Renames can introduce/remove whole directories or lack a filename.
        if (event === 'rename' || filename == null) { scan = true; schedule(); return; }
        try { markDirty(String(filename)); } catch (error) { failure(error); }
      });
      watcher.on?.('error', error => { failure(error); scan = true; schedule(); });
      watcher.on?.('close', () => { if (!closed && !closing) { failure(new Error('Watcher closed unexpectedly')); scan = true; schedule(); } });
    } catch (error) { failure(error); }
    if (reconcileMs > 0) {
      periodic = setInterval(() => { reconcile().catch(() => {}); }, reconcileMs);
      periodic.unref?.();
    }
    startPromise = reconcile();
    return startPromise;
  }
  function close() {
    if (closePromise) return closePromise;
    closing = true; clearTimeout(timer); clearInterval(periodic);
    watcher?.close?.();
    closePromise = enqueue(drain).finally(() => { closed = true; });
    return closePromise;
  }
  return { start, markDirty, flush, reconcile, close };
}
module.exports = { createIndexSync };
