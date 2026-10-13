'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const kernelPath = path.resolve(__dirname, '../alexandria-mcp/lib/kernel');

function contextProbe(t, mode, query) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'alexandria-context-fallback-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const vault = path.join(dir, 'vault');
  fs.mkdirSync(vault);
  fs.writeFileSync(path.join(vault, 'hot.md'), '', 'utf8');
  fs.writeFileSync(path.join(vault, 'Alpha.md'), '# Alpha\norbital covenant\n' + 'context-body '.repeat(200), 'utf8');
  const script = path.join(dir, 'probe.js');
  fs.writeFileSync(script, `
    const kernel = require(${JSON.stringify(kernelPath)});
    (async () => {
      try {
        const result = await kernel.handleRequest({ method: 'tools/call', params: {
          name: 'vault_context', arguments: { query: ${JSON.stringify(query)}, max_tokens: 200, limit: 1 }
        }});
        console.log(JSON.stringify(result));
      } finally { await kernel.close(); }
    })().catch(error => { console.error(error); process.exitCode = 1; });
  `, 'utf8');
  const env = { ...process.env,
    ALEXANDRIA_VAULT_DIR: vault,
    ALEXANDRIA_INDEX_DB: path.join(dir, 'index.db'),
    ALEXANDRIA_SETTINGS_PATH: path.join(dir, 'settings.json'),
    ALEXANDRIA_EXPANSION_CACHE: path.join(dir, 'expansion.json'),
    ALEXANDRIA_TELEMETRY: '0',
    ALEXANDRIA_RETRIEVAL_RRF: '0',
    ALEXANDRIA_RETRIEVAL_AUTHORITY: '0',
    ALEXANDRIA_ABSTENTION: '0',
    ALEXANDRIA_EMBEDDING_MODE: mode,
    ALEXANDRIA_MODEL_DIR: path.join(dir, 'PRIVATE_LOADER_DETAIL_missing_model'),
  };
  const processResult = spawnSync(process.execPath, [script], { env, encoding: 'utf8', timeout: 15000 });
  assert.equal(processResult.status, 0, processResult.stderr);
  const result = JSON.parse(processResult.stdout.trim());
  assert.notEqual(result.isError, true);
  return result.content[0].text;
}

test('positive trained context explicitly reports lexical model-unavailable fallback without changing content budget', t => {
  const result = contextProbe(t, 'trained', 'orbital');
  assert.match(result, /## Alpha \(`Alpha\.md`\)/);
  assert.match(result, /Budget: ~200\/200 tokens/);
  assert.match(result, /Retrieval fallback: lexical \(model_unavailable\)/);
  assert.doesNotMatch(result, /PRIVATE_LOADER_DETAIL|ENOENT|Error:/);
  const body = result.split('_\n\n')[1].split('\n\nRetrieval fallback:')[0];
  assert.equal(body.length, 800, 'max_tokens continues to bound note content');
});

test('empty trained context explicitly reports lexical model-unavailable fallback', t => {
  const result = contextProbe(t, 'trained', 'zzyzxquantalfa');
  assert.match(result, /Sem contexto relevante para "zzyzxquantalfa"/);
  assert.match(result, /Retrieval fallback: lexical \(model_unavailable\)/);
  assert.doesNotMatch(result, /PRIVATE_LOADER_DETAIL|ENOENT|Error:/);
});

test('default hash context preserves positive and empty responses without a fallback notice', t => {
  const positive = contextProbe(t, 'hash', 'orbital');
  const empty = contextProbe(t, 'hash', 'zzyzxquantalfa');
  assert.match(positive, /## Alpha \(`Alpha\.md`\)/);
  assert.match(positive, /Budget: ~200\/200 tokens/);
  assert.match(empty, /Sem contexto relevante/);
  assert.doesNotMatch(positive + empty, /Retrieval fallback|model_unavailable/);
});
