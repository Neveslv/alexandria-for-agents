#!/usr/bin/env node
'use strict';
// Explicit offline CI/manual smoke. No vault, index, credentials or downloads.
const {createLocalModelLoader}=require('../lib/retrieval/embeddings');
const profile=require('../lib/retrieval/model-profile.json');
(async()=>{
 const started=performance.now();
 const model=await createLocalModelLoader({modelRoot:process.env.ALEXANDRIA_MODEL_DIR,identity:profile})();
 try {
  const vector=await model('memória operacional e recuperação',{kind:'query'});
  if(vector.length!==profile.dimension||!vector.every(Number.isFinite))throw Error('Invalid model vector');
  console.log(JSON.stringify({dimension:vector.length,load_query_ms:performance.now()-started,rss_bytes:process.memoryUsage().rss}));
 } finally {await model.dispose();}
})().catch(()=>{console.error('Offline model smoke failed.');process.exitCode=1;});
