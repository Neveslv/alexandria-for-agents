 'use strict';
const crypto = require('node:crypto');
const {fuseRankings} = require('./fusion');
function meta(row) { if (typeof row.metadata==='string') {try{return JSON.parse(row.metadata)||{}}catch{return {}}} return row.metadata||{}; }
function array(value) { if(Array.isArray(value))return value;try{const a=JSON.parse(value||'[]');return Array.isArray(a)?a:[]}catch{return []} }
function cosine(a,b){if(!a||!b||a.length!==b.length)return 0;let dot=0,aa=0,bb=0;for(let i=0;i<a.length;i++){dot+=a[i]*b[i];aa+=a[i]*a[i];bb+=b[i]*b[i]}return aa&&bb?dot/Math.sqrt(aa*bb):0}
function safePath(p){return typeof p==='string'&&p&&!p.includes('\\')&&!p.includes('\0')&&!/^[a-z]:\//i.test(p)&&p.split('/').every(s=>s&&s!=='.'&&s!=='..')&&!p.split('/').some(s=>s.startsWith('.'))&&p.split('/')[0]!=='_archive'}
function inScope(row,args){const m=meta(row);const agent=args.agent||args.namespace;
 const prefix=row.path.split('/')[0];const effectiveAgent=m.agent||(['Codex','Nitro','shared'].includes(prefix)?prefix:'');if(agent&&effectiveAgent!==agent)return false;
 if(args.category&&String(row.category).toLowerCase()!==String(args.category).toLowerCase())return false;
 if(args.project&&m.project!==args.project&&m.project_id!==args.project)return false;
 const tags=array(row.tags||m.tags).map(t=>String(t).toLowerCase());if(args.tags&&!args.tags.every(t=>tags.includes(String(t).toLowerCase())))return false;
 if(args.after_date&&new Date(row.modified||0)<new Date(args.after_date))return false;
 return safePath(row.path);
}
function createRetrievalPipeline({getRows,indexSearch,hashSearch,getEmbedder,flags={},modelIdentity=null,calibration=null}) {
 // This candidate window is recorded in configuration identity and all ablations.
 const candidateWindow = 50;
 const configIdentity=crypto.createHash('sha256').update(JSON.stringify({version:1,authorityWeights:flags.authority?{current:1.10,superseded:0.85,canonical:1.10,maintained:1.05}:null,flags:{rrf:!!flags.rrf,authority:!!flags.authority,mode:flags.mode||'hash'},modelIdentity,candidateWindow})).digest('hex');
 return {configIdentity,async search(args={}){
  const query=String(args.query||'');const searchType=args.search_type||'hybrid';const limit=Math.max(1,Math.min(50,Number(args.limit)||10));
  const rows=getRows().filter(row=>inScope(row,args)).map(row=>({...row,metadata:meta(row)}));const byPath=new Map(rows.map(r=>[r.path,r]));
  const pack=(r,score)=>({...r,item_type:'note',snippet:r.snippet||r.content?.slice(0,400)||r.summary||'',matched_text:r.snippet||r.content?.slice(0,400)||r.summary||'',score});
  const lexicalCandidates=()=>indexSearch(query,Math.max(candidateWindow,getRows().length)).filter(r=>byPath.has(r.path)).slice(0,candidateWindow).map(r=>pack({...byPath.get(r.path),...r},r.score));
  let fts=searchType==='local_semantic'?[]:lexicalCandidates();
  let mode=searchType==='fts'?'lexical':flags.mode||'hash',fallback=null,vector=[];
  if(mode==='trained'){
   try{
    const embedder=await getEmbedder();const q=await embedder.embedQuery(query);
    for(const r of rows){const content=[r.title,r.category,r.summary||r.content].filter(Boolean).join(' ');const contentHash=r.checksum||crypto.createHash('sha256').update(r.content||content).digest('hex');const doc=await embedder.embedDocument({path:r.path,text:content,contentHash});const similarity=cosine(q,doc.vector);vector.push(pack(r,similarity));}
    vector.sort((a,b)=>b.score-a.score||(a.path<b.path?-1:1));vector=vector.slice(0,candidateWindow);
   }catch{mode='lexical';fallback='model_unavailable';vector=[];if(searchType==='local_semantic')fts=lexicalCandidates();}
  }else if(mode==='hash') vector=hashSearch(query,Math.max(candidateWindow,getRows().length)).filter(r=>byPath.has(r.path)).slice(0,candidateWindow).map(r=>pack(byPath.get(r.path),r.similarity));
  const tokens=query.toLowerCase().split(/\s+/).filter(t=>t.length>2);
  const entities=(searchType==='hybrid'?rows:[]).filter(r=>array(r.metadata.entities).some(entity=>tokens.some(t=>String(entity).toLowerCase().includes(t)))).sort((a,b)=>a.path<b.path?-1:1).slice(0,candidateWindow).map(r=>pack(r,1));
  const seedTitles=new Set(fts.slice(0,5).map(r=>r.title));
  const graph=(searchType==='hybrid'?rows:[]).filter(r=>[...seedTitles].some(title=>String(r.content||'').includes(`[[${title}]]`))).sort((a,b)=>a.path<b.path?-1:1).slice(0,candidateWindow).map(r=>pack(r,1));
  const streams={fts,vector,entity:entities,graph};
  const ranked=Object.fromEntries(Object.entries(streams).map(([stream,list])=>[stream,list.map((r,i)=>({...r,rank:i+1,rawScore:Number.isFinite(r.score)?r.score:null}))]));
  let items;
  if(flags.rrf){items=fuseRankings(ranked,{limit:candidateWindow}).map(r=>({...pack(byPath.get(r.path),r.score),evidence:r.evidence}));}
  else {const merged=new Map();for(const r of fts)merged.set(r.path,{...r,evidence:[{stream:'fts',rank:fts.indexOf(r)+1,contribution:r.score,rawScore:r.score}]});for(const r of vector){const old=merged.get(r.path);const score=r.score*5;merged.set(r.path,old?{...old,score:Math.max(old.score,score*.85),evidence:[...old.evidence,{stream:'vector',rank:vector.indexOf(r)+1,contribution:score,rawScore:r.score}]}:{...r,score:score*.85,evidence:[{stream:'vector',rank:vector.indexOf(r)+1,contribution:score,rawScore:r.score}]});}items=[...merged.values()].sort((a,b)=>b.score-a.score||(a.path<b.path?-1:1));}
  if(flags.authority){const {applyAuthority}=require('./authority');const intent=args.query_intent||(/hist[oó]r|previous|former|antig|superseded/i.test(query)?'historical':/current|atual|vigente|latest/i.test(query)?'current':'neutral');items=applyAuthority(items,{queryIntent:intent});}
  const effectiveIdentity=searchType==='hybrid'&&!fallback?configIdentity:crypto.createHash('sha256').update(configIdentity+':'+searchType+':'+(fallback||'')).digest('hex');
  let abstention=null;
  if(flags.abstention){const {decideAbstention}=require('./abstention');abstention=decideAbstention({hits:items,configIdentity:effectiveIdentity},calibration);if(abstention.abstain)items=[];}
  items=items.slice(0,limit).map(r=>({item_type:'note',path:r.path,title:r.title,category:r.category,
   permalink:r.permalink||'',source:r.source||(r.permalink?`memory://${r.permalink}`:r.path),heading:r.heading||'',
   summary:r.summary||'',snippet:String(r.snippet||'').slice(0,400),matched_text:String(r.matched_text||r.summary||'').slice(0,500),
   links:r.links||0,modified:r.modified||'',score:r.score,...(args.explain?{evidence:r.evidence}: {})}));
  return {query,items,retrieval:{mode,fallback,configIdentity:effectiveIdentity,candidateWindow,...(abstention?{abstention}:{})}};
 }};
}
module.exports={createRetrievalPipeline};
