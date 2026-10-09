#!/usr/bin/env node
/**
 * Loopback HTTP adapter over the Alexandria kernel.
 */

const http = require('node:http');
const { createHandler, assertLoopbackHost } = require('./app');
const { log, getVaultDir } = require('../lib/kernel');

const host = assertLoopbackHost(process.env.ALEXANDRIA_HTTP_HOST || '127.0.0.1');
const port = Number.parseInt(process.env.ALEXANDRIA_HTTP_PORT || '8787', 10);

if (!Number.isFinite(port) || port < 1) {
  throw new Error('Invalid ALEXANDRIA_HTTP_PORT');
}

const handler = createHandler();
const server = http.createServer(handler);

server.listen(port, host, () => {
  log(`HTTP v1 listening on http://${host}:${port} vault=${getVaultDir()}`);
});
