'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');

const EVENTS = new Set(['startup', 'discovery', 'shutdown', 'tool_received', 'tool_call', 'transport', 'protocol', 'client_attempt', 'client_result']);
const OUTCOMES = new Set(['unknown', 'received', 'success', 'tool_error', 'startup_error', 'transport_error', 'protocol_error']);
const CATEGORIES = new Set(['none', 'validation', 'execution', 'initialization', 'broken_pipe', 'io', 'invalid_json', 'invalid_request', 'unknown_tool', 'internal']);
const DEFAULT_DIR = path.join(os.homedir(), '.alexandria', 'telemetry');
function bounded(value, fallback, min, max) {
  const n = Number(value); return Number.isInteger(n) && n >= min && n <= max ? n : fallback;
}
function createTelemetry(options = {}) {
  const enabled = options.enabled ?? process.env.ALEXANDRIA_TELEMETRY === '1';
  const dir = options.dir || process.env.ALEXANDRIA_TELEMETRY_DIR || DEFAULT_DIR;
  const maxBytes = bounded(options.maxBytes ?? process.env.ALEXANDRIA_TELEMETRY_MAX_BYTES, 1048576, 1024, 104857600);
  const maxFiles = bounded(options.maxFiles ?? process.env.ALEXANDRIA_TELEMETRY_MAX_FILES, 10, 1, 1000);
  const retentionDays = bounded(options.retentionDays ?? process.env.ALEXANDRIA_TELEMETRY_RETENTION_DAYS, 7, 1, 365);
  const tools = new Set(options.tools || []);
  const prefix = options.channel === 'client' ? 'events-client' : `events-${crypto.randomUUID()}`;
  let sequence = 0;
  let file = path.join(dir, `${prefix}-${sequence}.jsonl`);
  function record(input) {
    if (!enabled || !EVENTS.has(input.event) || !OUTCOMES.has(input.outcome)) return;
    // Deliberately reconstruct the record: never serialize input, errors, or request data.
    const event = {
      schema_version: 1, timestamp: new Date().toISOString(), event: input.event,
      server_version: options.version || '2.0.0', outcome: input.outcome,
      error_category: CATEGORIES.has(input.error_category) ? input.error_category : (input.outcome === 'success' ? 'none' : 'internal'),
    };
    if (['tool_call','tool_received','client_attempt','client_result'].includes(input.event)) event.tool = tools.has(input.tool) ? input.tool : 'unknown';
    if (Number.isFinite(input.duration_ms) && input.duration_ms >= 0) event.duration_ms = Math.round(input.duration_ms * 1000) / 1000;
    let lock;
    try {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      if (options.channel === 'client') {
        const lockPath = path.join(dir,'.client-write-lock');
        try { fs.mkdirSync(lockPath); lock = lockPath; } catch { return; }
      }
      const line = JSON.stringify(event) + '\n';
      if (fs.existsSync(file) && fs.statSync(file).size + Buffer.byteLength(line) > maxBytes) {
        if (options.channel === 'client') fs.renameSync(file,path.join(dir,`events-client-${crypto.randomUUID()}.jsonl`));
        else file = path.join(dir, `${prefix}-${++sequence}.jsonl`);
      }
      fs.appendFileSync(file, line, { encoding: 'utf8', mode: 0o600 });
      const cutoff = Date.now() - retentionDays * 86400000;
      const files = fs.readdirSync(dir).filter(name => /^events-[\w-]+\.jsonl$/.test(name)).map(name => {
        const filename = path.join(dir, name); return { filename, modified: fs.statSync(filename).mtimeMs };
      }).sort((a, b) => b.modified - a.modified);
      for (const entry of files.filter(entry => entry.filename !== file).slice(maxFiles - 1)) fs.unlinkSync(entry.filename);
      for (const entry of files) if (entry.filename !== file && entry.modified < cutoff && fs.existsSync(entry.filename)) fs.unlinkSync(entry.filename);
    } catch { /* Logging is best effort and cannot affect the MCP result. */ }
    finally { if (lock) { try { fs.rmdirSync(lock); } catch {} } }
  }
  return { record };
}
function percentile(values, fraction) {
  if (!values.length) return null;
  return values[Math.max(0, Math.ceil(values.length * fraction) - 1)];
}
function metrics(events) {
  const successes = events.filter(e => e.outcome === 'success').length;
  const times = events.map(e => e.duration_ms).filter(n => Number.isFinite(n) && n >= 0).sort((a,b) => a-b);
  return { received: events.length, successes, errors: events.length - successes,
    success_rate: events.length ? successes / events.length : null,
    median_ms: times.length ? (times[Math.floor((times.length-1)/2)] + times[Math.ceil((times.length-1)/2)]) / 2 : null,
    p95_ms: percentile(times, .95) };
}
function summarize({ dir = process.env.ALEXANDRIA_TELEMETRY_DIR || DEFAULT_DIR, since, until } = {}) {
  const start = since === undefined ? -Infinity : Date.parse(since);
  const end = until === undefined ? Infinity : Date.parse(until);
  if (Number.isNaN(start) || Number.isNaN(end) || start > end) throw new Error('Invalid date range; use ISO timestamps with since <= until.');
  const events = []; let ignored = 0;
  if (fs.existsSync(dir)) for (const name of fs.readdirSync(dir).filter(n => /^events-[\w-]+\.jsonl$/.test(n))) {
    let raw; try { raw = fs.readFileSync(path.join(dir,name),'utf8'); } catch { continue; }
    for (const line of raw.split('\n').filter(l => l.trim())) {
      try {
        const e = JSON.parse(line); const ts = Date.parse(e.timestamp);
        if (e.schema_version !== 1 || !EVENTS.has(e.event) || !OUTCOMES.has(e.outcome) || !Number.isFinite(ts)) throw new Error('Invalid event');
        if (['tool_call','tool_received','client_attempt','client_result'].includes(e.event) && !/^(vault_[a-z_]+|unknown)$/.test(e.tool)) throw new Error('Invalid tool');
        if (ts >= start && ts <= end) events.push(e);
      } catch { ignored++; }
    }
  }
  const calls = events.filter(e => e.event === 'tool_call');
  const tools = Object.create(null);
  for (const name of new Set(calls.map(e => e.tool))) tools[name] = metrics(calls.filter(e => e.tool === name));
  return { period: { since: since || null, until: until || null }, scope: 'server_received_completed_calls',
    server: {...metrics(calls), observed_arrivals:events.filter(e=>e.event==='tool_received').length}, tools, ignored_lines: ignored,
    startup_failures: events.filter(e => e.event === 'startup' && e.outcome === 'startup_error').length,
    observed_transport_errors: events.filter(e => e.event === 'transport' && e.outcome === 'transport_error').length,
    protocol_errors: events.filter(e => e.event === 'protocol' && e.outcome === 'protocol_error').length,
    client_attempts: events.filter(e=>e.event==='client_attempt').length,
    client_results: { successes:events.filter(e=>e.event==='client_result' && e.outcome==='success').length,
      tool_errors:events.filter(e=>e.event==='client_result' && e.outcome==='tool_error').length,
      unknown:events.filter(e=>e.event==='client_result' && e.outcome==='unknown').length },
    client_timeouts: null,
    limitation: 'Cannot observe host-side connection failures, timeouts, undelivered requests, or calls interrupted before completion. Retention limits the available period.' };
}
module.exports = { createTelemetry, summarize, DEFAULT_DIR };
