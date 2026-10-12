const test=require('node:test'),assert=require('node:assert/strict');
const path=require('node:path');
function hit(path,title,metadata={}){return {path,title,category:'decisions',summary:title,content:title,metadata,permalink:title,snippet:title};}
function create(rows,extra={}){const {createRetrievalPipeline}=require('../alexandria-mcp/lib/retrieval/pipeline');return createRetrievalPipeline({getRows:()=>rows,indexSearch:()=>rows.slice().reverse().map((r,i)=>({...r,score:100-i})),hashSearch:()=>rows.map((r,i)=>({path:r.path,similarity:1-i*.1})),...extra});}
test('RRF filters scope before final ranking and explain is opt-in',async()=>{const rows=[hit('A.md','lease',{agent:'One',project:'A',tags:['important']}),hit('B.md','lease',{agent:'Two',project:'B',tags:['important']})];const p=create(rows,{flags:{rrf:true,mode:'hash'}});const a=await p.search({query:'lease',limit:5,agent:'One',project:'A',tags:['important'],explain:true});assert.deepEqual(a.items.map(x=>x.path),['A.md']);assert.ok(a.items[0].evidence.length);const b=await p.search({query:'lease'});assert.equal('evidence' in b.items[0],false);});
test('trained unavailable falls back explicitly to lexical and never hash vectors',async()=>{const rows=[hit('A.md','lease')];let usedHash=false;const p=create(rows,{flags:{rrf:true,mode:'trained'},hashSearch:()=>{usedHash=true;return[]},getEmbedder:()=>{throw Error('unavailable SECRET')}});const a=await p.search({query:'lease',explain:true});assert.equal(a.retrieval.mode,'lexical');assert.equal(a.retrieval.fallback,'model_unavailable');assert.equal(usedHash,false);assert.equal(JSON.stringify(a).includes('SECRET'),false);});
test('two required notes survive dedup and trained document identity cache path',async()=>{const rows=[hit('A.md','alpha'),hit('B.md','beta')];const p=create(rows,{flags:{rrf:true,mode:'trained'},getEmbedder:()=>({embedQuery:async()=>[1,0],embedDocument:async({path})=>({vector:path==='A.md'?[1,0]:[.9,.1]})})});const a=await p.search({query:'alpha beta',limit:5,explain:true});assert.deepEqual(new Set(a.items.map(x=>x.path)),new Set(['A.md','B.md']));assert.equal(a.items.length,2);assert.equal(a.retrieval.mode,'trained');});

test('explicit fts and local_semantic modes collect only requested streams',async()=>{const rows=[hit('A.md','alpha')];let hashCalls=0,ftsCalls=0;const p=create(rows,{flags:{rrf:true,mode:'hash'},indexSearch:()=>{ftsCalls++;return[]},hashSearch:()=>{hashCalls++;return[{path:'A.md',similarity:1}]}});const a=await p.search({query:'missing',search_type:'fts',explain:true});assert.equal(a.items.length,0);assert.equal(hashCalls,0);await p.search({query:'alpha',search_type:'local_semantic',explain:true});assert.equal(ftsCalls,1);assert.equal(hashCalls,1);});
test('agent metadata outranks legacy namespace and tags match case-insensitively',async()=>{const rows=[hit('Codex/A.md','alpha',{agent:'Other',tags:['Important']}),hit('B.md','beta',{agent:'Codex',tags:['Important']})];const p=create(rows,{flags:{rrf:true,mode:'hash'}});const a=await p.search({query:'alpha',agent:'Codex'});assert.deepEqual(a.items.map(x=>x.path),['B.md']);const b=await p.search({query:'beta',tags:['important']});assert.equal(b.items.length,2);});

test('public hits expose bounded citations without database internals',async()=>{
 const rows=[{...hit('A.md','alpha'),content:'private body '.repeat(1000),checksum:'internal',size:12000,note_type:'session'}];
 const a=await create(rows,{flags:{rrf:true,mode:'hash'}}).search({query:'alpha',explain:true});
 for(const key of ['content','checksum','size','metadata','note_type','tags'])assert.equal(key in a.items[0],false,key);
 assert.equal(a.items[0].source,'memory://alpha');assert.ok(a.items[0].matched_text.length<=500);assert.ok(a.items[0].evidence.length);
});

test('trained local_semantic unavailable uses lexical fallback candidates',async()=>{
 const rows=[hit('A.md','alpha')];const p=create(rows,{flags:{mode:'trained'},getEmbedder:()=>{throw Error('unavailable')}});
 const a=await p.search({query:'alpha',search_type:'local_semantic',explain:true});
 assert.equal(a.retrieval.fallback,'model_unavailable');assert.deepEqual(a.items.map(r=>r.path),['A.md']);assert.equal(a.items[0].evidence[0].stream,'fts');
});
