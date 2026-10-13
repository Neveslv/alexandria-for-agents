const test=require('node:test');const assert=require('node:assert/strict');
const {handleRequest}=require('../alexandria-mcp/lib/kernel');
test('kernel validation failures return MCP isError instead of a false success',()=>{
 for(const name of ['vault_write','vault_auto_save']) {const result=handleRequest({method:'tools/call',params:{name,arguments:{}}});assert.equal(result.isError,true);}
});
