'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {decideAbstention} = require('../alexandria-mcp/lib/retrieval/abstention');
const configIdentity = 'development-config';
const calibration = {schemaVersion:1,configIdentity,feature:'max_lexical_raw_score',threshold:2};
const hit = (score, stream='fts') => ({path:'decisions/example.md',score:99,evidence:[{stream,rawScore:score,rank:1,contribution:0.016}]});
const decide = hits => decideAbstention({hits,configIdentity},calibration);
test('empty-input abstains without relying on calibration',()=>assert.deepEqual(decide([]),{abstain:true,reasonCode:'empty_input'}));
test('unrelated-query abstains despite high vector or fused score',()=>assert.deepEqual(decide([hit(0.000003),hit(0.87,'vector')]),{abstain:true,reasonCode:'below_calibrated_lexical_evidence'}));
test('positive-paraphrase-kept by observed lexical evidence',()=>assert.deepEqual(decide([hit(3.4452035198367046)]),{abstain:false,reasonCode:'calibrated_evidence_present'}));
test('two-evidences-kept without filtering either hit',()=>{const hits=[hit(3),hit(0.8,'vector')];const before=structuredClone(hits);assert.equal(decide(hits).abstain,false);assert.deepEqual(hits,before)});
test('config-mismatch disables threshold decisions',()=>assert.deepEqual(decideAbstention({hits:[hit(0)],configIdentity:'other-model'},calibration),{abstain:false,reasonCode:'calibration_config_mismatch'}));
test('missing calibration explicitly retains hits',()=>assert.deepEqual(decideAbstention({hits:[hit(0)],configIdentity},null),{abstain:false,reasonCode:'calibration_unavailable'}));
test('malformed calibration does not suppress results',()=>{for(const threshold of [NaN,Infinity,-1,'2'])assert.equal(decideAbstention({hits:[hit(0)],configIdentity},{...calibration,threshold}).reasonCode,'calibration_invalid')});
test('score RRF alone and missing evidence cannot substitute for lexical evidence',()=>assert.equal(decide([{path:'x.md',score:100}]).reasonCode,'evidence_unavailable'));
test('vector-only evidence is known absence of lexical evidence',()=>assert.equal(decide([hit(0.99,'vector')]).abstain,true));
test('threshold equality retains positive evidence',()=>assert.equal(decide([hit(2)]).abstain,false));
test('nonfinite or string evidence is ignored',()=>{for(const score of [NaN,Infinity,'5'])assert.equal(decide([hit(score)]).abstain,true)});

const {spawnSync} = require('node:child_process');
const path = require('node:path');
const script = path.resolve(__dirname,'../evals/abstention/calibrate.py');
function calibrateReport(report) {
  return spawnSync('python',['-c',"import importlib.util,json,sys; s=importlib.util.spec_from_file_location('calibrate',sys.argv[1]); m=importlib.util.module_from_spec(s); s.loader.exec_module(m); print(json.dumps(m.calibrate(json.load(sys.stdin))))",script],{input:JSON.stringify(report),encoding:'utf8'});
}
function reportFixture() {
  const row = (id,relevant,score) => ({id,repeat:0,status:'ok',relevant,raw:{result:{content:[{text:'Ranking evidence: '+JSON.stringify({retrieval:{mode:'trained',fallback:null,configIdentity},items:[hit(score)]})}]}}});
  return {status:'ok',dataset:{name:'development',calibration_allowed:true,frozen_before_candidate_measurements:true,sha256:{'corpus.json':'frozen'}},rows:[row('positive',['decisions/example.md'],3),row('negative',[],0.000003)]};
}
test('calibrator derives floor from development positives and records frozen identity',()=>{const result=calibrateReport(reportFixture());assert.equal(result.status,0,result.stderr);const frozen=JSON.parse(result.stdout);assert.equal(frozen.configIdentity,configIdentity);assert.ok(frozen.threshold<3&&frozen.threshold>2.999999);assert.equal(frozen.development.negative_queries_abstained,1)});
test('changing development negatives cannot tune the threshold',()=>{const report=reportFixture();const first=JSON.parse(calibrateReport(report).stdout);report.rows[1].raw.result.content[0].text='Ranking evidence: '+JSON.stringify({retrieval:{mode:'trained',fallback:null,configIdentity},items:[hit(50)]});const changed=JSON.parse(calibrateReport(report).stdout);assert.equal(first.threshold,changed.threshold)});
test('calibrator refuses holdout and unfrozen evidence',()=>{for(const mutation of [r=>r.dataset.name='holdout',r=>r.dataset.calibration_allowed=false,r=>r.dataset.frozen_before_candidate_measurements=false]){const report=reportFixture();mutation(report);assert.notEqual(calibrateReport(report).status,0)}});
test('calibrator refuses mixed config evidence',()=>{const report=reportFixture();report.rows[1].raw.result.content[0].text=report.rows[1].raw.result.content[0].text.replace('development-config','other-model');assert.notEqual(calibrateReport(report).status,0)});

test('missing or invalid config identities disable calibrated suppression',()=>{
  for(const missing of [undefined,null,'',42]) {
    const result=decideAbstention({hits:[hit(0)],configIdentity:missing},{...calibration,configIdentity:missing});
    assert.deepEqual(result,{abstain:false,reasonCode:'calibration_config_missing'});
  }
});
test('calibrator rejects absent null empty and nonstring config identity',()=>{
  for(const missing of [undefined,null,'',42]) {
    const report=reportFixture();
    for(const row of report.rows)row.raw.result.content[0].text='Ranking evidence: '+JSON.stringify({retrieval:{mode:'trained',fallback:null,configIdentity:missing},items:[hit(row.relevant.length?3:0)]});
    assert.notEqual(calibrateReport(report).status,0);
  }
});
