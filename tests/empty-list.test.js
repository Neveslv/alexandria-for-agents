const test=require('node:test');const assert=require('node:assert/strict');const vm=require('node:vm');const fs=require('node:fs');const path=require('node:path');
test('an empty list is a valid successful result, not a tool error',()=>{
 const source=fs.readFileSync(path.join(__dirname,'../alexandria-mcp/lib/kernel.js'),'utf8');
 const sandbox={require,module:{exports:{}},process,console,Buffer,__dirname:path.join(__dirname,'../alexandria-mcp/lib')};
 vm.runInNewContext(source+'\nrefreshVaultIndex=()=>{};sqliteRows=()=>[];module.exports={handleVaultList};',sandbox);
 assert.notEqual(sandbox.module.exports.handleVaultList({category:'concepts'}).isError,true);
});
