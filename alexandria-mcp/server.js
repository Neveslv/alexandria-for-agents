#!/usr/bin/env node
/** Alexandria MCP stdio entrypoint. Telemetry never uses stdout. */
'use strict';
const readline = require('node:readline');
const { performance } = require('node:perf_hooks');
const { createTelemetry } = require('./lib/telemetry');
const { processLine } = require('./lib/stdio');
let telemetry = createTelemetry();
const started = performance.now();
let kernel;
try {
  kernel = require('./lib/kernel');
  telemetry = createTelemetry({tools:kernel.TOOLS.map(t=>t.name)});
  kernel.ensureReady();
  telemetry.record({event:'startup',outcome:'success',duration_ms:performance.now()-started});
} catch {
  telemetry.record({event:'startup',outcome:'startup_error',error_category:'initialization',duration_ms:performance.now()-started});
  process.stderr.write('Alexandria initialization failed. Check vault/index permissions and SQLite availability.\n');
  process.exit(1);
}
process.on('exit',()=>telemetry.record({event:'shutdown',outcome:'success'}));
for (const signal of ['SIGINT','SIGTERM']) process.on(signal,()=>process.exit(signal === 'SIGINT' ? 130 : 143));
if (process.argv.includes('--init')) {
  process.stdout.write(`Alexandria inicializado.\nVault: ${kernel.getVaultDir()}\nIndex: ${kernel.getIndexDb()}\n`);
} else {
  let transportFailed = false;
  function transportError(error) {
    if (transportFailed) return;
    transportFailed = true;
    telemetry.record({event:'transport',outcome:'transport_error',error_category:error?.code === 'EPIPE' ? 'broken_pipe' : 'io'});
    process.exit(1);
  }
  process.stdout.on('error',transportError);
  process.stdin.on('error',transportError);
  const tools = new Set(kernel.TOOLS.map(t=>t.name));
  const rl = readline.createInterface({input:process.stdin,terminal:false});
  rl.on('error',transportError);
  rl.on('line',line=>processLine(line,{
    handleRequest:kernel.handleRequest,tools,telemetry,
    send:response=>{
      try { process.stdout.write(JSON.stringify(response)+'\n',error=>{if(error)transportError(error);}); }
      catch (error) { transportError(error); }
    },
  }));
}
