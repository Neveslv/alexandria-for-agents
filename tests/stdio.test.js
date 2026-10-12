const test = require('node:test');
const assert = require('node:assert/strict');
const { processLine } = require('../alexandria-mcp/lib/stdio');
async function call(handleRequest, line) {const events=[]; const responses=[]; await processLine(line,{handleRequest,tools:new Set(['vault_read']),telemetry:{record:e=>events.push(e)},send:r=>responses.push(r)}); return {events,responses};}
test('tool successes, isError results, thrown errors and unknown tools are distinguished',async()=>{
 const line=JSON.stringify({jsonrpc:'2.0',id:7,method:'tools/call',params:{name:'vault_read',arguments:{path:'SECRET'}}});
 for(const [handler,outcome] of [[()=>({content:[]}), 'success'],[()=>({isError:true,content:[]}), 'tool_error'],[()=>{throw Error('SECRET');},'tool_error']]) {
 const {events,responses}=await call(handler,line); assert.equal(events[0].event,'tool_received'); assert.equal(events[1].outcome,outcome); assert.equal(responses[0].id,7); assert.ok(!JSON.stringify(events).includes('SECRET'));}
 const unknown=await call(()=>{throw Error('should not dispatch');},line.replace('vault_read','SECRET'));assert.equal(unknown.events[1].error_category,'unknown_tool');
});
test('malformed JSON is a parse error; valid but invalid requests are not parse errors',async()=>{
 assert.equal((await call(()=>{},'{bad')).responses[0].error.code,-32700);
 for(const value of [null,[],{id:1}, {jsonrpc:'2.0',method:'tools/call',id:{secret:'SECRET'} }]) assert.equal((await call(()=>{},JSON.stringify(value))).responses[0].error.code,-32600);
});
test('notifications produce no stdout response; discovery is recorded separately',async()=>{
 assert.equal((await call(()=>({}),JSON.stringify({jsonrpc:'2.0',method:'notifications/initialized'}))).responses.length,0);
 const {events}=await call(()=>({tools:[]}),JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/list'}));assert.equal(events[0].event,'discovery');
});
