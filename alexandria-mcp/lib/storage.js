'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { migrateStorage } = require('./migrations/001-storage');

/** One synchronous SQLite connection per store. SQL values use bound parameters.
 * exec without parameters accepts trusted multi-statement SQL for kernel batches.
 * Transaction callbacks must finish synchronously and must not start a transaction.
 */
function openStore({ dbPath } = {}) {
  if (typeof dbPath !== 'string' || !dbPath.trim()) throw new TypeError('dbPath must be a nonempty string');
  if (dbPath !== ':memory:') fs.mkdirSync(path.dirname(path.resolve(dbPath)), { recursive: true });
  const db = new DatabaseSync(dbPath);
  try {
    db.exec('PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL;');
    migrateStorage(db);
  } catch (error) {
    db.close();
    throw error;
  }
  let closed = false;
  let inTransaction = false;
  function assertOpen() {
    if (closed) throw new Error('Store is closed');
  }
  return {
    exec(sql, params = []) {
      assertOpen();
      if (!Array.isArray(params)) throw new TypeError('SQL params must be an array');
      if (params.length === 0) return db.exec(sql);
      return db.prepare(sql).run(...params);
    },
    all(sql, params = []) {
      assertOpen();
      if (!Array.isArray(params)) throw new TypeError('SQL params must be an array');
      return db.prepare(sql).all(...params);
    },
    transaction(fn) {
      assertOpen();
      if (inTransaction) throw new Error('Nested transactions are not supported');
      if (typeof fn !== 'function') throw new TypeError('Transaction callback must be a function');
      if (Object.prototype.toString.call(fn) === '[object AsyncFunction]') {
        throw new TypeError('Transaction callback must be synchronous; async functions are not supported');
      }
      db.exec('BEGIN IMMEDIATE');
      inTransaction = true;
      try {
        const result = fn();
        if (result && typeof result.then === 'function') {
          // Avoid an unhandled rejection from a rejected Promise returned by a
          // misused synchronous callback. No asynchronous work is awaited here.
          if (result instanceof Promise) result.catch(() => {});
          throw new TypeError('Transaction callback must be synchronous; Promise results are not supported');
        }
        db.exec('COMMIT');
        return result;
      } catch (error) {
        try { db.exec('ROLLBACK'); }
        catch (rollbackError) { throw new AggregateError([error, rollbackError], 'Transaction and rollback failed'); }
        throw error;
      } finally {
        inTransaction = false;
      }
    },
    close() {
      if (closed) return;
      if (inTransaction) throw new Error('Cannot close store during a transaction');
      db.close();
      closed = true;
    },
  };
}

module.exports = { openStore };
