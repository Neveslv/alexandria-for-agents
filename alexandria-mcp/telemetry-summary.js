#!/usr/bin/env node
'use strict';
const { summarize } = require('./lib/telemetry');
const args = process.argv.slice(2); const options = {};
try {
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--help') { console.log('Usage: node telemetry-summary.js [--dir PATH] [--since ISO_TIMESTAMP] [--until ISO_TIMESTAMP]'); process.exit(0); }
    const key = args[i].slice(2);
    if (!['dir','since','until'].includes(key) || !args[i].startsWith('--') || !args[i+1] || args[i+1].startsWith('--')) throw new Error('Invalid option. Use --help.');
    options[key] = args[++i];
  }
  console.log(JSON.stringify(summarize(options), null, 2));
} catch (error) { console.error(error.message); process.exitCode = 1; }
