'use strict';
// Independent from legacy embeddings(path,vector): trained vectors never mix
// with hash embeddings. Apply using the injected synchronous Store contract.
function migrateEmbeddings(store) {
  store.transaction(() => store.exec(`CREATE TABLE IF NOT EXISTS retrieval_embeddings (
    path TEXT NOT NULL, content_hash TEXT NOT NULL,
    provider TEXT NOT NULL, model TEXT NOT NULL, revision TEXT NOT NULL,
    dimension INTEGER NOT NULL CHECK (dimension > 0), vector TEXT NOT NULL,
    PRIMARY KEY (path, content_hash, provider, model, revision, dimension)
  ); CREATE INDEX IF NOT EXISTS retrieval_embeddings_path ON retrieval_embeddings(path);`));
}
module.exports = { migrateEmbeddings };
