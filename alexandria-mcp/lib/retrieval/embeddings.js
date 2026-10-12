'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { migrateEmbeddings } = require('../migrations/002-embeddings');
class EmbeddingError extends Error {
  constructor(category) { super(category); this.name = 'EmbeddingError'; this.category = category; }
}
const fail = category => new EmbeddingError(category);
function modelIdentity(value) {
  if (!value || ['provider','model','revision'].some(k=>typeof value[k] !== 'string' || !value[k].trim()) || !Number.isSafeInteger(value.dimension) || value.dimension < 1) throw fail('invalid_identity');
  return Object.freeze({provider:value.provider,model:value.model,revision:value.revision,dimension:value.dimension});
}
function normalized(vector, dimension) {
  if (!Array.isArray(vector) && !(ArrayBuffer.isView(vector) && !(vector instanceof DataView))) throw fail('invalid_vector');
  if (vector.length !== dimension) throw fail('dimension_mismatch');
  const values = Array.from(vector);
  if (values.some(x=>typeof x !== 'number' || !Number.isFinite(x))) throw fail('invalid_vector');
  const scale = Math.max(...values.map(Math.abs));
  if (!Number.isFinite(scale) || scale === 0) throw fail('invalid_vector');
  const norm = Math.sqrt(values.reduce((n,x)=>n+(x/scale)**2,0));
  return values.map(x=>(x/scale)/norm);
}
function createEmbedder({identity,loadModel,store} = {}) {
  const id = modelIdentity(identity);
  if (!store || !['exec','all','transaction'].every(k=>typeof store[k] === 'function')) throw fail('invalid_store');
  if (typeof loadModel !== 'function') throw fail('unavailable_model');
  try { migrateEmbeddings(store); } catch { throw fail('storage_error'); }
  const identityParams = [id.provider,id.model,id.revision,id.dimension];
  const pending = new Map(), generations = new Map(), active = new Set();
  let closed = false, modelPromise, adapter, closing;
  const assertOpen = () => { if (closed) throw fail('closed'); };
  const track = promise => { active.add(promise); promise.then(()=>active.delete(promise),()=>active.delete(promise)); return promise; };
  async function model() {
    if (!modelPromise) {
      modelPromise = Promise.resolve().then(loadModel).then(value=>{
        if (typeof value !== 'function' && !(value && typeof value.document === 'function' && typeof value.query === 'function')) throw fail('unavailable_model');
        adapter = value; return value;
      }).catch(()=>{modelPromise=undefined;throw fail('unavailable_model');});
    }
    return modelPromise;
  }
  async function embed(text, kind) {
    assertOpen();
    if (typeof text !== 'string') throw fail('invalid_input');
    const value = await model(); assertOpen();
    let vector;
    try { vector = await (typeof value === 'function' ? value(text,{kind}) : value[kind](text)); }
    catch { throw fail('unavailable_model'); }
    assertOpen(); return normalized(vector,id.dimension);
  }
  function embedQuery(text) { return track(embed(text,'query')); }
  function embedDocument(input) {
    try {
      assertOpen();
      if (!input || typeof input.path !== 'string' || !input.path || input.path.includes('\\') || path.posix.isAbsolute(input.path) || /^[A-Za-z]:/.test(input.path) || input.path.split('/').some(p=>!p || p==='.' || p==='..') || typeof input.text !== 'string' || typeof input.contentHash !== 'string' || !input.contentHash) throw fail('invalid_input');
      const {path:notePath,text,contentHash} = input;
      const current = pending.get(notePath);
      if (current && current.hash === contentHash) return current.promise.then(record=>({...record,vector:[...record.vector]}));
      const generation = (generations.get(notePath)||0)+1; generations.set(notePath,generation);
      const work = Promise.resolve().then(async()=>{
        assertOpen();
        let rows;
        try { rows = store.all('SELECT vector FROM retrieval_embeddings WHERE path=? AND content_hash=? AND provider=? AND model=? AND revision=? AND dimension=?',[notePath,contentHash,...identityParams]); }
        catch { throw fail('storage_error'); }
        let vector;
        if (rows.length) {
          try { vector = normalized(JSON.parse(rows[0].vector),id.dimension); }
          catch { throw fail('invalid_vector'); }
        } else {
          vector = await embed(text,'document');
          assertOpen();
          if (generations.get(notePath) !== generation) throw fail('invalidated');
          try { store.transaction(()=>{
            store.exec('DELETE FROM retrieval_embeddings WHERE path=? AND provider=? AND model=? AND revision=? AND dimension=?',[notePath,...identityParams]);
            store.exec('INSERT INTO retrieval_embeddings(path,content_hash,provider,model,revision,dimension,vector) VALUES(?,?,?,?,?,?,?)',[notePath,contentHash,...identityParams,JSON.stringify(vector)]);
          }); } catch { throw fail('storage_error'); }
        }
        assertOpen();
        if (generations.get(notePath) !== generation) throw fail('invalidated');
        return {path:notePath,contentHash,identity:{...id},vector};
      });
      pending.set(notePath,{hash:contentHash,promise:work});
      const clean=()=>{if(pending.get(notePath)?.promise===work)pending.delete(notePath)};
      work.then(clean,clean); return track(work);
    } catch (error) { return Promise.reject(error); }
  }
  function invalidate(notePath) {
    assertOpen();
    if (typeof notePath !== 'string' || !notePath) throw fail('invalid_input');
    generations.set(notePath,(generations.get(notePath)||0)+1); pending.delete(notePath);
    try {store.exec('DELETE FROM retrieval_embeddings WHERE path=?',[notePath]);} catch {throw fail('storage_error');}
  }
  function close() {
    if (!closing) {
      closed = true;
      closing = (async()=>{
        await Promise.allSettled([...active]);
        if (adapter && typeof adapter.dispose === 'function') {
          try {await adapter.dispose();} catch {throw fail('unavailable_model');}
        }
        pending.clear(); generations.clear();
      })();
    }
    return closing;
  }
  return {embedQuery,embedDocument,invalidate,close};
}
/** Explicit offline model root containing <identity.model>/manifest.json.
 * Manifest validates the pinned identity and every local runtime file once per
 * successful loader lifecycle. importRuntime is injectable for offline tests.
 */
function createLocalModelLoader({modelRoot,identity,importRuntime=()=>import('@huggingface/transformers')} = {}) {
  const id = modelIdentity(identity);
  if (typeof modelRoot !== 'string' || !path.isAbsolute(modelRoot) || id.provider !== 'transformers.js' || !/^Xenova\/multilingual-e5-small$/.test(id.model)) throw fail('unavailable_model');
  const root = path.resolve(modelRoot);
  const modelDir = path.join(root,id.model);
  let loading, loadGeneration = 0;
  return function loadLocalModel() {
    if (!loading) {
      const generation = ++loadGeneration;
      loading = (async()=>{
      const manifest = JSON.parse(await fs.readFile(path.join(modelDir,'manifest.json'),'utf8'));
      if (['provider','model','revision','dimension'].some(k=>manifest[k]!==id[k])) throw fail('unavailable_model');
      const required=['config.json','tokenizer.json','tokenizer_config.json','special_tokens_map.json','onnx/model_quantized.onnx'];
      for (const filename of required) if (!manifest.files?.[filename]) throw fail('unavailable_model');
      const realDir=await fs.realpath(modelDir);
      for (const [filename, expected] of Object.entries(manifest.files)) {
        const absolute=path.resolve(modelDir,filename);
        if (!absolute.startsWith(modelDir+path.sep) || filename.includes('\\') || !Number.isSafeInteger(expected.bytes) || !/^[a-f0-9]{64}$/.test(expected.sha256)) throw fail('unavailable_model');
        const realFile=await fs.realpath(absolute);
        if(!realFile.startsWith(realDir+path.sep))throw fail('unavailable_model');
        const data=await fs.readFile(realFile);
        if(data.length!==expected.bytes || createHash('sha256').update(data).digest('hex')!==expected.sha256)throw fail('unavailable_model');
      }
      const runtime=await importRuntime();
      runtime.env.allowRemoteModels=false;
      runtime.env.allowLocalModels=true;
      runtime.env.localModelPath=root+path.sep;
      runtime.env.useFSCache=false;
      const extractor=await runtime.pipeline('feature-extraction',id.model,{local_files_only:true,revision:id.revision,dtype:'q8',device:'cpu'});
      let disposed = false, disposal;
      const fn=async(text,{kind}={})=>{
        if (disposed) throw fail('unavailable_model');
        try {const result=await extractor(`${kind==='query'?'query':'passage'}: ${text}`,{pooling:'mean',normalize:true});return Array.from(result.data);}
        catch {throw fail('unavailable_model');}
      };
      fn.dispose = () => {
        if (!disposal) {
          disposed = true;
          // Retire before asynchronous disposal, allowing a fresh lifecycle.
          // Repeated disposal of an old adapter must not clear a newer load.
          if (generation === loadGeneration) {
            loading = undefined;
            ++loadGeneration;
          }
          disposal = Promise.resolve().then(() => extractor.dispose?.())
            .catch(() => { throw fail('unavailable_model'); });
        }
        return disposal;
      };
      return fn;
      })().catch(()=>{
        if (generation === loadGeneration) loading = undefined;
        throw fail('unavailable_model');
      });
    }
    return loading;
  };
}
module.exports={createEmbedder,createLocalModelLoader,EmbeddingError};
