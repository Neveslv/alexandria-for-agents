const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createTelemetry, summarize } = require('../alexandria-mcp/lib/telemetry');
function temp(t) { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'alexandria-telemetry-')); t.after(() => fs.rmSync(dir, {recursive:true, force:true})); return dir; }
test('records only safe fields and summarizes completed calls', t => {
  const dir = temp(t); const logger = createTelemetry({enabled:true, dir, version:'2.0.0', tools:['vault_read']});
  logger.record({event:'tool_call', tool:'vault_read', outcome:'success', duration_ms:12, arguments:{secret:'SECRET'}, content:'SECRET'});
  logger.record({event:'tool_call', tool:'SECRET', outcome:'tool_error', error_category:'SECRET', duration_ms:30});
  const raw = fs.readdirSync(dir).map(f => fs.readFileSync(path.join(dir,f),'utf8')).join('');
  assert.equal(raw.includes('SECRET'), false);
  const report = summarize({dir});
  assert.equal(report.server.received, 2); assert.equal(report.server.successes, 1); assert.equal(report.server.errors, 1);
  assert.equal(report.server.success_rate, .5); assert.equal(report.server.p95_ms, 30);
  assert.equal(report.tools.vault_read.median_ms,12);
});
test('disabled collection does not create files; failed logging never throws', t => {
 const dir = path.join(temp(t), 'missing'); createTelemetry({enabled:false, dir}).record({event:'startup',outcome:'success'}); assert.equal(fs.existsSync(dir),false);
 fs.writeFileSync(dir,'blocked'); assert.doesNotThrow(() => createTelemetry({enabled:true, dir}).record({event:'startup',outcome:'success'}));
});
test('rotation and retention bound the log size and file count', t => {
 const dir=temp(t); const logger=createTelemetry({enabled:true,dir,maxBytes:1024,maxFiles:3});
 for(let i=0;i<100;i++)logger.record({event:'startup',outcome:'success'});
 const files=fs.readdirSync(dir); assert.ok(files.length<=3); for(const f of files)assert.ok(fs.statSync(path.join(dir,f)).size<=1024);
});
test('summary filters dates and tolerates malformed/truncated logs', t => {
 const dir=temp(t); fs.writeFileSync(path.join(dir,'events-test.jsonl'), JSON.stringify({schema_version:1,timestamp:'2026-01-01T00:00:00.000Z',event:'tool_call',tool:'vault_read',outcome:'success',duration_ms:10})+'\n{broken\n');
 assert.equal(summarize({dir,since:'2026-02-01T00:00:00Z'}).server.received,0);
 assert.equal(summarize({dir}).ignored_lines,1);
 assert.throws(()=>summarize({dir,since:'invalid'}));
});
