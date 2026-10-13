'use strict';
const { performance } = require('node:perf_hooks');
async function processLine(line, { handleRequest, tools, telemetry, send }) {
  if (!line.trim()) return;
  let request;
  try { request = JSON.parse(line); }
  catch {
    telemetry.record({event:'protocol',outcome:'protocol_error',error_category:'invalid_json'});
    send({jsonrpc:'2.0',id:null,error:{code:-32700,message:'Parse error'}}); return;
  }
  if (!request || Array.isArray(request) || request.jsonrpc !== '2.0' || typeof request.method !== 'string' ||
      (request.id !== undefined && request.id !== null && typeof request.id !== 'string' && typeof request.id !== 'number')) {
    telemetry.record({event:'protocol',outcome:'protocol_error',error_category:'invalid_request'});
    send({jsonrpc:'2.0',id:null,error:{code:-32600,message:'Invalid request'}}); return;
  }
  const isCall = request.method === 'tools/call';
  const isDiscovery = request.method === 'tools/list';
  const tool = request.params?.name;
  const start = performance.now();
  if (isCall) telemetry.record({event:'tool_received',tool,outcome:'received'});
  let result; let category = 'none';
  try {
    if (isCall && !tools.has(tool)) {
      category = 'unknown_tool'; result = {isError:true,content:[{type:'text',text:'Unknown tool'}]};
    } else result = await handleRequest(request);
    if (result?.isError || result?.error) category = category === 'none' ? 'execution' : category;
  } catch {
    category = 'execution';
    result = isCall ? {isError:true,content:[{type:'text',text:'Tool execution failed'}]} : {error:{code:-32603,message:'Internal error'}};
  }
  if (isCall || isDiscovery) telemetry.record({event:isCall ? 'tool_call' : 'discovery',tool,
    outcome:category === 'none' ? 'success' : 'tool_error',error_category:category,duration_ms:performance.now()-start});
  if (request.id === undefined || result === undefined) return;
  send({jsonrpc:'2.0',id:request.id,...(result.error ? {error:result.error} : {result})});
}
module.exports = { processLine };
