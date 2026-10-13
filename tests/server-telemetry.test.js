const test=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs');const path=require('node:path');const os=require('node:os');const {spawnSync}=require('node:child_process');
const {summarize}=require('../alexandria-mcp/lib/telemetry');
function fixture(t,kernel){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'alexandria-process-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));fs.mkdirSync(path.join(dir,'lib'));for(const file of ['server.js','lib/stdio.js','lib/telemetry.js'])fs.copyFileSync(path.join(__dirname,'../alexandria-mcp',file),path.join(dir,file));fs.writeFileSync(path.join(dir,'lib/kernel.js'),kernel);return dir;}
const stub="exports.TOOLS=[{name:'vault_read'}];exports.ensureReady=()=>{};exports.handleRequest=r=>r.method==='tools/list'?{tools:exports.TOOLS}:r.params?.arguments?.fail?{isError:true,content:[]}:{content:[]};";
test('fresh server keeps stdout JSON-RPC clean and logs lifecycle plus calls',t=>{
 const dir=fixture(t,stub),logs=path.join(dir,'logs'); const result=spawnSync(process.execPath,[path.join(dir,'server.js')],{encoding:'utf8',input:[{jsonrpc:'2.0',id:1,method:'tools/list'},{jsonrpc:'2.0',id:2,method:'tools/call',params:{name:'vault_read',arguments:{path:'SECRET'}}},{jsonrpc:'2.0',id:3,method:'tools/call',params:{name:'vault_read',arguments:{fail:true}}}].map(JSON.stringify).join('\n')+'\n',env:{...process.env,ALEXANDRIA_TELEMETRY:'1',ALEXANDRIA_TELEMETRY_DIR:logs},timeout:5000});
 assert.equal(result.status,0,result.stderr);const responses=result.stdout.trim().split('\n').map(JSON.parse);assert.equal(responses.length,3);assert.equal(responses[2].result.isError,true);
 const report=summarize({dir:logs});assert.equal(report.server.observed_arrivals,2);assert.equal(report.server.errors,1);assert.equal(report.server.successes,1);
 const raw=fs.readdirSync(logs).map(f=>fs.readFileSync(path.join(logs,f),'utf8')).join('');assert.ok(raw.includes('shutdown'));assert.ok(!raw.includes('SECRET'));
});
test('initialization failure is a distinct event with no sensitive error text',t=>{
 const dir=fixture(t,"throw Error('SECRET')"),logs=path.join(dir,'logs');const result=spawnSync(process.execPath,[path.join(dir,'server.js')],{encoding:'utf8',env:{...process.env,ALEXANDRIA_TELEMETRY:'1',ALEXANDRIA_TELEMETRY_DIR:logs},timeout:5000});assert.equal(result.status,1);assert.equal(result.stdout,'');assert.ok(!result.stderr.includes('SECRET'));assert.equal(summarize({dir:logs}).startup_failures,1);
});
test('broken stdout pipe records an observed transport failure',t=>{
 const dir=fixture(t,stub),logs=path.join(dir,'logs');const preload=path.join(dir,'broken-pipe.js');fs.writeFileSync(preload,"const original=process.stdout.write;process.stdout.write=function(){const e=new Error('SECRET');e.code='EPIPE';process.nextTick(()=>process.stdout.emit('error',e));return false;};");
 const result=spawnSync(process.execPath,['--require',preload,path.join(dir,'server.js')],{encoding:'utf8',input:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/list'})+'\n',env:{...process.env,ALEXANDRIA_TELEMETRY:'1',ALEXANDRIA_TELEMETRY_DIR:logs},timeout:5000});assert.equal(result.status,1);assert.equal(summarize({dir:logs}).observed_transport_errors,1);
});
