const test=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs');const os=require('node:os');const path=require('node:path');const {spawnSync}=require('node:child_process');
const {createTelemetry}=require('../alexandria-mcp/lib/telemetry');
test('summary CLI honors telemetry directory environment without writing new events',t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'alexandria-summary-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 createTelemetry({enabled:true,dir,tools:['vault_read']}).record({event:'tool_call',tool:'vault_read',outcome:'success',duration_ms:1});
 const files=fs.readdirSync(dir);const result=spawnSync(process.execPath,[path.join(__dirname,'../alexandria-mcp/telemetry-summary.js')],{encoding:'utf8',env:{...process.env,ALEXANDRIA_TELEMETRY_DIR:dir}});
 assert.equal(result.status,0);assert.equal(JSON.parse(result.stdout).server.successes,1);assert.deepEqual(fs.readdirSync(dir),files);
});
