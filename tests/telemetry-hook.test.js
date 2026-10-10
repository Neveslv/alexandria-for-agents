const test=require('node:test'); const assert=require('node:assert/strict');
const { collectHook }=require('../alexandria-mcp/telemetry-hook');
test('Codex hooks retain only tool name and observed status, never response or args',()=>{
 const events=[]; const telemetry={record:e=>events.push(e)};
 collectHook({hook_event_name:'PreToolUse',tool_name:'mcp__alexandria__vault_read',tool_input:{path:'SECRET'}},telemetry);
 collectHook({hook_event_name:'PostToolUse',tool_name:'mcp__alexandria__vault_read',tool_response:{isError:true,content:[{text:'SECRET'}]}},telemetry);
 assert.equal(events[0].event,'client_attempt');assert.equal(events[1].outcome,'tool_error');assert.ok(!JSON.stringify(events).includes('SECRET'));
 collectHook({hook_event_name:'PostToolUse',tool_name:'mcp__other__vault_read'},telemetry);assert.equal(events.length,2);
});
test('unrecognized hook result does not invent a success or timeout',()=>{
 const events=[]; collectHook({hook_event_name:'PostToolUse',tool_name:'mcp__alexandria__vault_read',tool_response:'unexpected'}, {record:e=>events.push(e)});
 assert.equal(events[0].outcome,'unknown');
});
