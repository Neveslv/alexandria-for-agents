 'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {spawnSync}=require('node:child_process');
const root=path.resolve(__dirname,'..');
function isolated(t){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'alexandria-delivery-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));return {dir,env:{...process.env,HOME:dir,USERPROFILE:dir,ALEXANDRIA_VAULT_DIR:path.join(dir,'vault'),ALEXANDRIA_INDEX_DB:path.join(dir,'index.db'),ALEXANDRIA_SETTINGS_PATH:path.join(dir,'settings.json'),ALEXANDRIA_EXPANSION_CACHE:path.join(dir,'expansion.json'),ALEXANDRIA_TELEMETRY:'0',ALEXANDRIA_RETRIEVAL_RRF:'0',ALEXANDRIA_RETRIEVAL_AUTHORITY:'0',ALEXANDRIA_ABSTENTION:'0',ALEXANDRIA_EMBEDDING_MODE:'hash',ALEXANDRIA_HTTP_TOKEN:''}};}
test('installed server includes offline retrieval and HTTP runtime dependencies',t=>{
 const {dir,env}=isolated(t);const r=spawnSync(process.execPath,[path.join(root,'install.js'),'--vault',env.ALEXANDRIA_VAULT_DIR,'--client','cursor'],{env,encoding:'utf8',timeout:30000});assert.equal(r.status,0,r.stderr);
 const installed=path.join(dir,'.alexandria/mcp-server');
 for(const file of ['lib/storage.js','lib/index-sync.js','lib/migrations/001-storage.js','lib/migrations/002-embeddings.js','lib/retrieval/pipeline.js','lib/retrieval/model-profile.json','bin/prepare-model.js','bin/alexandria-http','http/server.js','http/app.js','web/index.html','package.json','package-lock.json'])assert.equal(fs.existsSync(path.join(installed,file)),true,file);
 const discovered=spawnSync(process.execPath,[path.join(installed,'server.js')],{env,input:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/list'})+'\n',encoding:'utf8',timeout:5000});assert.equal(discovered.status,0,discovered.stderr);assert.ok(JSON.parse(discovered.stdout).result.tools.length>0);
 assert.equal(fs.existsSync(path.join(installed,'node_modules')),false);assert.ok(fs.existsSync(path.join(dir,'.alexandria/vault-index.db')));
});
test('real loopback HTTP search preserves filters citations limits and explain',t=>{
 const {dir,env}=isolated(t);const script=path.join(dir,'probe.js');
 const source=`const http=require('node:http'),fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
 const kernel=require(${JSON.stringify(path.join(root,'alexandria-mcp/lib/kernel'))});const {createHandler}=require(${JSON.stringify(path.join(root,'alexandria-mcp/http/app'))});
 (async()=>{let server;try{
 fs.mkdirSync(process.env.ALEXANDRIA_VAULT_DIR,{recursive:true});for(const [name,project] of [['Alpha','One'],['Beta','Two']])fs.writeFileSync(path.join(process.env.ALEXANDRIA_VAULT_DIR,name+'.md'),'---\\ntitle: '+name+'\\nproject: '+project+'\\n---\\n# '+name+'\\norbital covenant');
 server=http.createServer(createHandler());await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const base='http://127.0.0.1:'+server.address().port;
 const response=await fetch(base+'/v1/search',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({query:'orbital',project:'One',limit:1,explain:true,include_snippets:false})});assert.equal(response.status,200);const body=await response.json();assert.equal(body.items.length,1);assert.equal(body.items[0].path,'Alpha.md');assert.ok(body.items[0].evidence.length);assert.equal('content' in body.items[0],false);assert.ok(body.retrieval.configIdentity);
 const outside=await fetch(base+'/v1/search',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({query:'orbital',project:'Missing',limit:5})});assert.equal((await outside.json()).items.length,0);
 console.log(JSON.stringify({ok:true}));
 }finally{if(server)await new Promise(resolve=>server.close(resolve));await kernel.close();}})().catch(e=>{console.error(e);process.exitCode=1;});`;
 fs.writeFileSync(script,source);const r=spawnSync(process.execPath,[script],{env,encoding:'utf8',timeout:20000});assert.equal(r.status,0,r.stderr);assert.equal(JSON.parse(r.stdout).ok,true);
});
