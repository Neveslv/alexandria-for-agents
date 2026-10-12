'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
let api = {};
try { api = require('../alexandria-mcp/lib/retrieval/embeddings'); } catch (error) { if (error.code !== 'MODULE_NOT_FOUND') throw error; }
const identity = {provider:'fake',model:'e5',revision:'r1',dimension:2};
function store(t) {
 const db = new DatabaseSync(':memory:'); t.after(()=>db.close());
 return {exec(sql,p=[]){return p.length ? db.prepare(sql).run(...p) : db.exec(sql)}, all(sql,p=[]){return db.prepare(sql).all(...p)}, transaction(fn){db.exec('BEGIN');try {const v=fn();db.exec('COMMIT');return v}catch(e){db.exec('ROLLBACK');throw e}}};
}
function make(t,opts={}) {assert.equal(typeof api.createEmbedder,'function','createEmbedder must exist'); const s=opts.store||store(t); const e=api.createEmbedder({identity,store:s,loadModel:async()=>async()=>[3,4],...opts});t.after(()=>e.close());return {e,s};}
const doc = {path:'projects/note.md',text:'private note',contentHash:'hash1'};
function category(c){return e=> {assert.equal(e.category,c);assert.equal(e.message,c);assert.ok(!String(e.stack).includes('private note'));return true};}
test('same-model-cache-hit survives reopen and caller mutation',async t=>{let calls=0;const s=store(t);const loader=async()=>async()=>{calls++;return [3,4]};const {e}=make(t,{store:s,loadModel:loader});const a=await e.embedDocument(doc);assert.deepEqual(a.vector,[.6,.8]);a.vector[0]=9;await e.close();const {e:b}=make(t,{store:s,loadModel:loader});const cached=(await b.embedDocument(doc)).vector;assert.ok(Math.abs(cached[0]-.6)<1e-12);assert.ok(Math.abs(cached[1]-.8)<1e-12);assert.equal(calls,1)});
test('same-size-content-invalidates',async t=>{let calls=0;const {e}=make(t,{loadModel:async()=>async text=>{calls++;return text==='private note'?[1,0]:[0,1]}});await e.embedDocument(doc);assert.deepEqual((await e.embedDocument({...doc,text:'changed note',contentHash:'hash2'})).vector,[0,1]);assert.equal(calls,2)});
test('all identity fields distinguish cached vectors',async t=>{const s=store(t);await make(t,{store:s}).e.embedDocument(doc);for(const changed of [{revision:'r2'},{provider:'other'},{model:'other'},{dimension:3}]) {let calls=0;const id={...identity,...changed};const {e}=make(t,{store:s,identity:id,loadModel:async()=>async()=>{calls++;return Array(id.dimension).fill(1)}});await e.embedDocument(doc);assert.equal(calls,1)} });
test('dimension-mismatch and invalid vectors never enter store',async t=>{for(const [v,c] of [[[1],'dimension_mismatch'],[[NaN,1],'invalid_vector'],[[Infinity,1],'invalid_vector'],[[0,0],'invalid_vector']]) {const {e,s}=make(t,{loadModel:async()=>async()=>v});await assert.rejects(e.embedDocument(doc),category(c));assert.equal(s.all('SELECT * FROM retrieval_embeddings').length,0)}});
test('unavailable-model is private and retries loading',async t=>{let loads=0;const {e}=make(t,{loadModel:async()=>{if(++loads===1)throw Error('private note');return async()=>[1,0]}});await assert.rejects(e.embedQuery('private note'),category('unavailable_model'));assert.deepEqual(await e.embedQuery('ok'),[1,0]);assert.equal(loads,2)});
test('concurrent-load-once and document coalescing',async t=>{let loads=0,calls=0;const {e}=make(t,{loadModel:async()=>{loads++;await new Promise(r=>setImmediate(r));return async()=>{calls++;return [1,0]}}});await Promise.all([e.embedDocument(doc),e.embedDocument(doc),e.embedQuery('q')]);assert.equal(loads,1);assert.equal(calls,2)});
test('invalidate removes every identity and blocks stale in-flight persistence',async t=>{const s=store(t);await make(t,{store:s}).e.embedDocument(doc);await make(t,{store:s,identity:{...identity,revision:'r2'}}).e.embedDocument(doc);let release,started;const start=new Promise(r=>started=r);const {e}=make(t,{store:s,loadModel:async()=>async()=>{started();await new Promise(r=>release=r);return [1,0]}});const p=e.embedDocument({...doc,contentHash:'h3'});await start;e.invalidate(doc.path);release();await assert.rejects(p,category('invalidated'));assert.equal(s.all('SELECT * FROM retrieval_embeddings').length,0)});
test('newer content cannot be overwritten by older in-flight content',async t=>{let release,started;const start=new Promise(r=>started=r);const {e,s}=make(t,{loadModel:async()=>async text=>{if(text===doc.text){started();await new Promise(r=>release=r);return [1,0]}return [0,1]}});const p=e.embedDocument(doc);await start;await e.embedDocument({...doc,text:'new',contentHash:'new'});release();await assert.rejects(p,category('invalidated'));assert.equal(s.all('SELECT content_hash FROM retrieval_embeddings')[0].content_hash,'new')});
test('close blocks new work, drains loader and disposes once',async t=>{let release,started,disposed=0;const start=new Promise(r=>started=r);const {e,s}=make(t,{loadModel:async()=>{started();await new Promise(r=>release=r);const f=async()=>[1,0];f.dispose=async()=>disposed++;return f}});const p=e.embedDocument(doc);await start;const closing=e.close();await assert.rejects(e.embedQuery('private note'),category('closed'));release();await assert.rejects(p,category('closed'));await closing;await e.close();assert.equal(disposed,1);assert.equal(s.all('SELECT * FROM retrieval_embeddings').length,0)});
test('local loader requires pinned manifest, checks files and prefixes E5',async t=>{assert.equal(typeof api.createLocalModelLoader,'function');const dir=fs.mkdtempSync(path.join(os.tmpdir(),'embed-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));const id={provider:'transformers.js',model:'Xenova/multilingual-e5-small',revision:'r1',dimension:2};const modelDir=path.join(dir,id.model);fs.mkdirSync(path.join(modelDir,'onnx'),{recursive:true});const crypto=require('node:crypto');const files={};for(const name of ['config.json','tokenizer.json','tokenizer_config.json','special_tokens_map.json','onnx/model_quantized.onnx']){fs.writeFileSync(path.join(modelDir,name),'{}');files[name]={bytes:2,sha256:crypto.createHash('sha256').update('{}').digest('hex')}}fs.writeFileSync(path.join(modelDir,'manifest.json'),JSON.stringify({...id,files}));const seen=[];const runtime={env:{},pipeline:async()=>{const f=async text=>{seen.push(text);return {data:Float32Array.from([1,0])}};return f}};const loader=api.createLocalModelLoader({modelRoot:dir,identity:id,importRuntime:async()=>runtime});const model=await loader();await model('ola',{kind:'query'});await model('nota',{kind:'document'});assert.deepEqual(seen,['query: ola','passage: nota']);assert.equal(runtime.env.allowRemoteModels,false);assert.equal(runtime.env.localModelPath,dir+path.sep);fs.writeFileSync(path.join(modelDir,'config.json'),'bad');const bad=api.createLocalModelLoader({modelRoot:dir,identity:id,importRuntime:async()=>runtime});await assert.rejects(bad(),category('unavailable_model'))});

test('migration preserves legacy embeddings and is idempotent', async t => {
  const s = store(t);
  s.exec('CREATE TABLE embeddings(path TEXT PRIMARY KEY,vector TEXT)');
  s.exec('INSERT INTO embeddings VALUES(?,?)', ['legacy.md','[7,8]']);
  const { e } = make(t, { store:s });
  make(t, { store:s });
  await e.embedDocument(doc);
  assert.deepEqual({...s.all('SELECT * FROM embeddings')[0]}, {path:'legacy.md',vector:'[7,8]'});
});
test('document/query adapter receives correct kind', async t => {
  const {e} = make(t, {loadModel:async () => ({document:async () => [1,0], query:async () => [0,1]})});
  assert.deepEqual((await e.embedDocument(doc)).vector,[1,0]);
  assert.deepEqual(await e.embedQuery('query'),[0,1]);
});
test('corrupt persisted vectors are rejected without invoking inference', async t => {
  const s=store(t);
  await make(t,{store:s}).e.embedDocument(doc);
  s.exec('UPDATE retrieval_embeddings SET vector=?',['[null,1]']);
  const {e}=make(t,{store:s,loadModel:async()=>{throw Error('must not load')}});
  await assert.rejects(e.embedDocument(doc),category('invalid_vector'));
});
function localFixture(t) {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'embed-reopen-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const id={provider:'transformers.js',model:'Xenova/multilingual-e5-small',revision:'r1',dimension:2};
  const modelDir=path.join(root,id.model);
  fs.mkdirSync(path.join(modelDir,'onnx'),{recursive:true});
  const files={};
  for(const name of ['config.json','tokenizer.json','tokenizer_config.json','special_tokens_map.json','onnx/model_quantized.onnx']) {
    fs.writeFileSync(path.join(modelDir,name),'{}');
    files[name]={bytes:2,sha256:require('node:crypto').createHash('sha256').update('{}').digest('hex')};
  }
  fs.writeFileSync(path.join(modelDir,'manifest.json'),JSON.stringify({...id,files}));
  return {root,id};
}
test('same local loader reopens after embedder closes its disposed adapter',async t=>{
  const {root,id}=localFixture(t);
  let loads=0;
  const runtime={env:{},pipeline:async()=>{
    loads++;
    let disposed=false;
    const extractor=async()=>{if(disposed)throw Error('disposed');return {data:[1,0]}};
    extractor.dispose=async()=>{disposed=true};
    return extractor;
  }};
  const loadModel=api.createLocalModelLoader({modelRoot:root,identity:id,importRuntime:async()=>runtime});
  const first=make(t,{identity:id,loadModel}).e;
  assert.deepEqual(await first.embedQuery('one'),[1,0]);
  await first.close();
  const second=make(t,{identity:id,loadModel}).e;
  assert.deepEqual(await second.embedQuery('two'),[1,0]);
  assert.equal(loads,2);
});
test('old adapter disposal cannot clear a newer local loader generation',async t=>{
  const {root,id}=localFixture(t);
  let release,loads=0,disposes=0;
  const runtime={env:{},pipeline:async()=>{
    const n=++loads;
    const extractor=async()=>({data:[1,0]});
    extractor.dispose=async()=>{disposes++;if(n===1)await new Promise(r=>release=r)};
    return extractor;
  }};
  const loader=api.createLocalModelLoader({modelRoot:root,identity:id,importRuntime:async()=>runtime});
  const old=await loader();
  const disposing=old.dispose();
  const newer=await loader();
  assert.notEqual(newer,old);
  release();await disposing;
  await old.dispose();
  assert.equal(await loader(),newer);
  assert.equal(loads,2);
  assert.equal(disposes,1);
  await newer.dispose();
});
