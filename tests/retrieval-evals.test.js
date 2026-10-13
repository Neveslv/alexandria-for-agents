const test = require('node:test');
const assert = require('node:assert/strict');
const {spawnSync} = require('node:child_process');
const path = require('node:path');
function py(code) {
 const r=spawnSync(process.env.PYTHON || 'python',['-B','-c',code],{cwd:path.resolve(__dirname,'..'),encoding:'utf8',timeout:12000});
 assert.equal(r.status,0,r.stderr || r.error?.message);return JSON.parse(r.stdout);
}
test('scoring uses headers only, unique hits and partial multi-note recall',()=>{
 const r=py("import sys,json;sys.path.insert(0,'evals/retrieval');from score import score,extract_paths;t='1. Wrong '+chr(96)+'concepts/wrong.md'+chr(96)+'\\nSnippet [[concepts/right.md]]\\n';print(json.dumps([score({'relevant':['concepts/right.md']},extract_paths({'text':t})),score({'relevant':['a.md','b.md']},['a.md','a.md'])]))");
 assert.equal(r[0].hit_at_5,0);assert.equal(r[1].recall_at_5,.5);assert.ok(r[1].ndcg_at_5<1);
});
test('negatives stay outside positive means',()=>{
 const r=py("import sys,json;sys.path.insert(0,'evals/retrieval');from score import summarize;print(json.dumps(summarize([{'repeat':0,'relevant':['a'],'paths':['a'],'group':'x'},{'repeat':0,'relevant':[],'paths':['b'],'group':'absent'}])))");
 assert.equal(r.all_positive.queries,1);assert.equal(r.all_positive.hit_at_5,1);assert.equal(r.absent.correct_abstention,0);
});
test('MCP timeouts terminate unresponsive children without hanging',()=>{
 const r=py("import sys,json,tempfile,time;sys.path.insert(0,'evals/retrieval');from mcp_client import MCP,RequestTimeout;t=time.monotonic();m=MCP([sys.executable,'-u','-c','import time;time.sleep(60)'],log_path=tempfile.mktemp());ok=False\ntry:m.call('initialize',{},timeout=.15)\nexcept RequestTimeout:ok=True\nfinally:m.close()\nprint(json.dumps({'timeout':ok,'elapsed':time.monotonic()-t,'exit':m.process.poll()}))");
 assert.equal(r.timeout,true);assert.ok(r.elapsed<4);assert.notEqual(r.exit,null);
});
test('MCP drains stderr, skips notifications, and propagates remote errors',()=>{
 const r=py("import sys,json,tempfile;sys.path.insert(0,'evals/retrieval');from mcp_client import MCP;s=\"import sys,json\\nsys.stderr.write('x'*100000);sys.stderr.flush()\\nfor line in sys.stdin:\\n r=json.loads(line)\\n if 'id' in r:\\n  print(json.dumps({'jsonrpc':'2.0','method':'notice'}),flush=True)\\n  print(json.dumps({'jsonrpc':'2.0','id':r['id'],'error':{'code':-1,'message':'synthetic'}}),flush=True)\";m=MCP([sys.executable,'-u','-c',s],log_path=tempfile.mktemp());ok=False\ntry:m.call('x',{},timeout=2)\nexcept RuntimeError:ok=True\nfinally:m.close()\nprint(json.dumps(ok))");
 assert.equal(r,true);
});
test('frozen fixtures validate and seven preserved baselines reproduce',()=>{
 const r=py("import sys,json;from pathlib import Path;sys.path.insert(0,'evals/retrieval');from benchmark import load_dataset;from report import verify_preserved;[load_dataset(Path('evals/retrieval/fixtures')/n) for n in ['original','development','holdout']];print(json.dumps(verify_preserved(Path('evals/retrieval/fixtures/original'))))");
 assert.equal(r.files,7);assert.ok(r.max_delta<1e-12);
});
test('frozen fixture hashes are stable across CRLF and LF checkouts',()=>{
 const r=py("import sys,json,tempfile;from pathlib import Path;sys.path.insert(0,'evals/retrieval');from benchmark import digest\nwith tempfile.TemporaryDirectory() as d:\n p=Path(d)/'lf.json';q=Path(d)/'crlf.json';p.write_bytes(b'{\\n  \\\"fixture\\\": true\\n}\\n');q.write_bytes(p.read_bytes().replace(b'\\n',b'\\r\\n'))\n print(json.dumps(digest(p)==digest(q)))");
 assert.equal(r,true);
});
test('dataset mutation is rejected before server launch',()=>{
 const r=py("import sys,json,tempfile,shutil;from pathlib import Path;sys.path.insert(0,'evals/retrieval');from benchmark import load_dataset;ok=False\nwith tempfile.TemporaryDirectory() as tmp:\n d=Path(tmp)/'data';shutil.copytree('evals/retrieval/fixtures/holdout',d);(d/'queries.json').write_text('[]')\n try:load_dataset(d)\n except ValueError:ok=True\nprint(json.dumps(ok))");
 assert.equal(r,true);
});
test('MCP notification storms cannot extend request deadlines',()=>{
 const r=py("import sys,json,tempfile,time;sys.path.insert(0,'evals/retrieval');from mcp_client import MCP,RequestTimeout;s=\"import sys,json\\nfor line in sys.stdin:\\n while True:print(json.dumps({'jsonrpc':'2.0','method':'notice'}),flush=True)\";m=MCP([sys.executable,'-u','-c',s],log_path=tempfile.mktemp());ok=False;t=time.monotonic()\ntry:m.call('x',{},timeout=.15)\nexcept RequestTimeout:ok=True\nfinally:m.close()\nprint(json.dumps({'timeout':ok,'elapsed':time.monotonic()-t}))");
 assert.equal(r.timeout,true);assert.ok(r.elapsed<4);
});
test('frozen original corpus scale is selectable without label changes',()=>{
 const r=py("import sys,json;from pathlib import Path;sys.path.insert(0,'evals/retrieval');from benchmark import load_dataset;print(json.dumps(len(load_dataset(Path('evals/retrieval/fixtures/original'),corpus_name='corpus-120.json')[0])))");
 assert.equal(r,120);
});
test('formatter paths follow category separator, never title code or numbered snippets',()=>{
 const r=py("import sys,json;sys.path.insert(0,'evals/retrieval');from score import extract_paths;t='1. **Use '+chr(96)+'concepts/title-code.md'+chr(96)+' safely** [note:concepts] — '+chr(96)+'concepts/actual.md'+chr(96)+'\\n2. Snippet example '+chr(96)+'concepts/spoof.md'+chr(96)+'\\n   3. **Indented snippet** [note:concepts] — '+chr(96)+'concepts/indented.md'+chr(96)+'\\n';print(json.dumps(extract_paths({'text':t})))");
 assert.deepEqual(r,['concepts/actual.md']);
});
test('all harness retrieval requests suppress snippets and preserve raw MCP responses',()=>{
 const r=py("import sys,json,tempfile;from pathlib import Path;sys.path.insert(0,'evals/retrieval');import benchmark;from benchmark import run;requests=[]\nclass Client:\n def __init__(self,*a):self.closed=False;self.process=type('Process',(),{'poll':lambda self:None})();Path(a[2]).write_text('')\n def initialize(self,*a):return {},1\n def call(self,method,args,timeout):\n  if method=='tools/list':return {'result':{'tools':[{'name':'vault_search'}]}},1\n  requests.append(args['arguments']);return {'result':{'content':[{'type':'text','text':'1. **Synthetic** [note:decisions] — '+chr(96)+'decisions/lease.md'+chr(96)}]}},1\n def close(self):self.closed=True\nbenchmark.MCP=Client\nwith tempfile.TemporaryDirectory() as tmp:\n r=run(Path('.'),Path('evals/retrieval/fixtures/development'),Path(tmp)/'out',1,1)\n print(json.dumps({'snippet_flags':[q.get('include_snippets') for q in requests],'raw_preserved':r['rows'][0]['raw']['result']['content'][0]['text'].startswith('1. **Synthetic**')}))");
 assert.ok(r.snippet_flags.length>0);assert.ok(r.snippet_flags.every(v=>v===false));assert.equal(r.raw_preserved,true);
});
