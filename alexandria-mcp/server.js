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
  // Loading the transport/discovery must not start indexing or model loading.
  telemetry.record({event:'startup',outcome:'success',duration_ms:performance.now()-started});
} catch {
  telemetry.record({event:'startup',outcome:'startup_error',error_category:'initialization',duration_ms:performance.now()-started});
  process.stderr.write('Alexandria initialization failed. Check vault/index permissions and SQLite availability.\n');
  process.exit(1);
}
process.on('exit',()=>telemetry.record({event:'shutdown',outcome:'success'}));
const inFlight = new Set();
let rl;
let shutdownPromise;
function shutdown(code = 0) {
  if (code) process.exitCode = code;
  if (shutdownPromise) return shutdownPromise;
  shutdownPromise = (async()=>{
    await Promise.allSettled([...inFlight]);
    if (typeof kernel.close === 'function') await kernel.close();
  })().catch(()=>{
    process.exitCode = 1;
    process.stderr.write('Alexandria shutdown failed.\n');
  });
  rl?.close();
  return shutdownPromise;
}
for (const signal of ['SIGINT','SIGTERM']) process.on(signal,()=>{
  process.stdin.destroy();
  void shutdown(signal === 'SIGINT' ? 130 : 143);
});
if (process.argv.includes('--init')) {
  const init = Promise.resolve().then(()=>kernel.ensureDataReady ? kernel.ensureDataReady() : kernel.ensureReady()).then(()=>{
    process.stdout.write(`Alexandria inicializado.\nVault: ${kernel.getVaultDir()}\nIndex: ${kernel.getIndexDb()}\n`);
  }).catch(()=>{
    process.exitCode = 1;
    process.stderr.write('Alexandria initialization failed.\n');
  });
  inFlight.add(init);
  void init.finally(()=>{inFlight.delete(init);void shutdown();});
} else {
  let transportFailed = false;
  function transportError(error) {
    if (transportFailed) return;
    transportFailed = true;
    telemetry.record({event:'transport',outcome:'transport_error',error_category:error?.code === 'EPIPE' ? 'broken_pipe' : 'io'});
    process.stdin.destroy();
    void shutdown(1);
  }
  process.stdout.on('error',transportError);
  process.stdin.on('error',transportError);
  const tools = new Set(kernel.TOOLS.map(t=>t.name));
  rl = readline.createInterface({input:process.stdin,terminal:false});
  rl.on('error',transportError);
  rl.on('line',line=>{
    const pending = processLine(line,{
      handleRequest:kernel.handleRequest,tools,telemetry,
      send:response=>{
        try { process.stdout.write(JSON.stringify(response)+'\n',error=>{if(error)transportError(error);}); }
        catch (error) { transportError(error); }
      },
    }).catch(transportError);
    inFlight.add(pending);
    void pending.finally(()=>inFlight.delete(pending));
  });
  rl.on('close',()=>{void shutdown();});
}
