'use strict';

// Additive schema compatible with the published kernel. Unknown columns and
// existing FTS rows are deliberately left intact. DDL names/types are constants.
const tables = {
  pages: [
    ['path', 'TEXT PRIMARY KEY'], ['title', 'TEXT'], ['category', 'TEXT'],
    ['content', 'TEXT'], ['summary', 'TEXT'], ['modified', 'TEXT'],
    ['links', 'INTEGER DEFAULT 0'], ['permalink', 'TEXT'], ['note_type', 'TEXT'],
    ['tags', 'TEXT'], ['metadata', 'TEXT'], ['checksum', 'TEXT'], ['size', 'INTEGER DEFAULT 0'],
  ],
  embeddings: [['path', 'TEXT PRIMARY KEY'], ['vector', 'TEXT']],
  observations: [
    ['id', 'TEXT PRIMARY KEY'], ['path', 'TEXT'], ['title', 'TEXT'], ['category', 'TEXT'],
    ['content', 'TEXT'], ['tags', 'TEXT'], ['context', 'TEXT'], ['permalink', 'TEXT'], ['modified', 'TEXT'],
  ],
  relations: [
    ['id', 'TEXT PRIMARY KEY'], ['path', 'TEXT'], ['title', 'TEXT'], ['relation_type', 'TEXT'],
    ['target', 'TEXT'], ['context', 'TEXT'], ['permalink', 'TEXT'], ['modified', 'TEXT'],
  ],
};

function migrateStorage(db) {
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const [table, columns] of Object.entries(tables)) {
      db.exec(`CREATE TABLE IF NOT EXISTS ${table} (${columns.map(([name, type]) => `${name} ${type}`).join(',')})`);
      const existing = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map(row => row.name));
      for (const [name, type] of columns) {
        if (existing.has(name)) continue;
        if (type.includes('PRIMARY KEY')) throw new Error(`Incompatible storage schema: ${table}.${name} is missing`);
        db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${type}`);
      }
    }
    db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS pages_fts USING fts5(
      path UNINDEXED, title, category, content, summary
    )`);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

module.exports = { migrateStorage };
