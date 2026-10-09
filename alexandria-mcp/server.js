#!/usr/bin/env node
/**
 * Alexandria MCP stdio entrypoint. Vault logic lives in lib/kernel.js.
 */

const readline = require('node:readline');
const {
  handleRequest,
  ensureReady,
  getVaultDir,
  getIndexDb,
  getStoreSizes,
  log,
} = require('./lib/kernel');

if (process.argv.includes('--init')) {
  ensureReady();
  process.stdout.write(`Alexandria inicializado.\nVault: ${getVaultDir()}\nIndex: ${getIndexDb()}\n`);
  process.exit(0);
}

const rl = readline.createInterface({ input: process.stdin, terminal: false });

rl.on('line', (line) => {
  if (!line.trim()) return;
  try {
    const request = JSON.parse(line);
    const result = handleRequest(request);

    if (result === undefined) return;

    const response = { jsonrpc: '2.0', id: request.id };
    if (result.error) {
      response.error = result.error;
    } else {
      response.result = result;
    }

    process.stdout.write(JSON.stringify(response) + '\n');
  } catch (e) {
    const errResponse = {
      jsonrpc: '2.0',
      id: null,
      error: { code: -32700, message: `Parse error: ${e.message}` },
    };
    process.stdout.write(JSON.stringify(errResponse) + '\n');
  }
});

log('initializing vault...');
ensureReady();
const sizes = getStoreSizes();
log(`MCP server v2.0 started — ${sizes.api} API embs, ${sizes.local} local embs, ${sizes.expansions} cached expansions`);
