#!/usr/bin/env node
'use strict';
const { createTelemetry } = require('./lib/telemetry');
const TOOLS = ['vault_recall','vault_search','vault_read','vault_context','vault_write','vault_auto_save','vault_list','vault_recent_activity','vault_stats'];
function collectHook(input, telemetry) {
  const match = /^mcp__alexandria__(vault_[a-z_]+)$/.exec(input?.tool_name || '');
  if (!match || !TOOLS.includes(match[1])) return;
  if (input.hook_event_name === 'PreToolUse') telemetry.record({event:'client_attempt',tool:match[1],outcome:'received'});
  if (input.hook_event_name === 'PostToolUse') {
    const result = input.tool_response;
    const known = result && typeof result === 'object' && (Array.isArray(result.content) || typeof result.isError === 'boolean');
    telemetry.record({event:'client_result',tool:match[1],outcome:known ? (result.isError ? 'tool_error' : 'success') : 'unknown',error_category:known && result.isError ? 'execution' : 'none'});
  }
}
if (require.main === module) {
  // Hook failures never block a tool and hook stdout stays empty.
  let input = ''; let oversized = false;
  process.stdin.setEncoding('utf8');
  process.stdin.on('data',chunk=>{if (input.length + chunk.length > 1048576) {oversized=true;input='';} else if (!oversized) input+=chunk;});
  process.stdin.on('error',()=>{});
  process.stdin.on('end',()=>{if (oversized) return; try { collectHook(JSON.parse(input),createTelemetry({enabled:process.argv.includes('--enabled') || process.env.ALEXANDRIA_TELEMETRY === '1',channel:'client',tools:TOOLS})); } catch {} });
}
module.exports = { collectHook };
