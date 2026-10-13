#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = __dirname;
const SOURCE = path.join(ROOT, 'alexandria-mcp');
const HOME = os.homedir();
const INSTALL_DIR = path.join(HOME, '.alexandria', 'mcp-server');
const INDEX_DB = path.join(HOME, '.alexandria', 'vault-index.db');
const START = '<!-- BEGIN Alexandria Agent Memory -->';
const END = '<!-- END Alexandria Agent Memory -->';
let telemetryEnabled = false;

function parseArgs(argv) {
  const args = { vault: '', client: 'codex', dryRun: false };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === '--dry-run') args.dryRun = true;
    else if (flag === '--telemetry') args.telemetry = true;
    else if (['--vault', '--client'].includes(flag)) {
      const value = argv[++index];
      if (!value || value.startsWith('--')) throw new Error(`Missing value for ${flag}`);
      args[flag.slice(2)] = value;
    } else if (flag === '--help' || flag === '-h') args.help = true;
    else throw new Error(`Unknown option: ${flag}`);
  }
  return args;
}

function usage() {
  return [
    'Alexandria for Agents installer',
    '',
    'Usage: node install.js --vault PATH [--client codex|cursor|claude-code|gemini-cli|all] [--dry-run] [--telemetry]',
    '',
    'Clients need to be installed separately. “all” configures every supported client adapter.',
  ].join('\n');
}

function run(command, args, options = {}) {
  let result;
  if (process.platform === 'win32') {
    const payload = Buffer.from(JSON.stringify([command, ...args]), 'utf8').toString('base64');
    const script = "$v=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('" + payload + "')) | ConvertFrom-Json; $c=$v[0]; $a=@($v | Select-Object -Skip 1); & $c @a; exit $LASTEXITCODE";
    const encoded = Buffer.from(script, 'utf16le').toString('base64');
    result = spawnSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], {
      encoding: 'utf8', env: options.env || process.env, windowsHide: true,
    });
  } else {
    result = spawnSync(command, args, { encoding: 'utf8', env: options.env || process.env });
  }
  if (result.error) return { status: 127, stdout: '', stderr: result.error.message };
  return { status: result.status ?? 1, stdout: result.stdout || '', stderr: result.stderr || '' };
}

function executableAvailable(command) {
  const result = run(process.platform === 'win32' ? 'where.exe' : 'which', [command]);
  return result.status === 0;
}

function backup(file) {
  if (!fs.existsSync(file)) return;
  const stamp = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
  fs.copyFileSync(file, `${file}.bak.${stamp}`);
}

function writeJson(file, mutate, dryRun) {
  let value = {};
  if (fs.existsSync(file)) {
    try { value = JSON.parse(fs.readFileSync(file, 'utf8')); }
    catch (error) { throw new Error(`Cannot parse ${file}: ${error.message}`); }
  }
  mutate(value);
  if (dryRun) {
    console.log(`DRY RUN: update ${file}`);
    return;
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  backup(file);
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  fs.renameSync(temp, file);
  console.log(`Updated ${file}`);
}

function renderPrompt(vault, agent) {
  return fs.readFileSync(path.join(ROOT, 'AI-PROMPT.md'), 'utf8')
    .replaceAll('__VAULT_PATH__', vault)
    .replaceAll('__AGENT__', agent);
}

function installInstruction(file, prompt, dryRun) {
  let current = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  const block = `${START}\n${prompt.trim()}\n${END}`;
  const startAt = current.indexOf(START);
  const endAt = current.indexOf(END);
  if (startAt >= 0 && endAt >= startAt) {
    current = `${current.slice(0, startAt)}${block}${current.slice(endAt + END.length)}`;
  } else {
    current = `${current.trimEnd()}${current.trimEnd() ? '\n\n' : ''}${block}\n`;
  }
  if (dryRun) {
    console.log(`DRY RUN: install always-on instructions in ${file}`);
    return;
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  backup(file);
  fs.writeFileSync(file, current, 'utf8');
  console.log(`Installed always-on instructions in ${file}`);
}

function cursorConfig(server, vault, dryRun) {
  const file = path.join(HOME, '.cursor', 'mcp.json');
  writeJson(file, config => {
    if (!config.mcpServers || typeof config.mcpServers !== 'object') config.mcpServers = {};
    config.mcpServers.alexandria = {
      command: process.execPath,
      args: [server],
      env: { ALEXANDRIA_VAULT_DIR: vault, ALEXANDRIA_NAMESPACE: 'Cursor', ALEXANDRIA_INDEX_DB: INDEX_DB, ALEXANDRIA_TELEMETRY: telemetryEnabled ? '1' : '0' },
    };
  }, dryRun);
  if (dryRun) {
    console.log('DRY RUN: install always-on Cursor rule');
    return;
  }
  const source = fs.readFileSync(path.join(ROOT, 'rules', 'alexandria.mdc'), 'utf8')
    .replaceAll('__VAULT_PATH__', vault).replaceAll('__AGENT__', 'Cursor');
  const rule = path.join(HOME, '.cursor', 'rules', 'alexandria.mdc');
  fs.mkdirSync(path.dirname(rule), { recursive: true });
  backup(rule);
  fs.writeFileSync(rule, source, 'utf8');
  console.log(`Installed always-on Cursor rule in ${rule}`);
}

function configureCodex(server, vault, dryRun) {
  const cli = 'codex';
  if (!executableAvailable(cli)) throw new Error('Codex CLI was not found. Install it, or choose another client.');
  const existing = run(cli, ['mcp', 'get', 'alexandria']);
  if (existing.status !== 0) {
    const args = ['mcp', 'add', 'alexandria',
      '--env', `ALEXANDRIA_VAULT_DIR=${vault}`,
      '--env', 'ALEXANDRIA_NAMESPACE=Codex',
      '--env', `ALEXANDRIA_INDEX_DB=${INDEX_DB}`,
      '--env', `ALEXANDRIA_TELEMETRY=${telemetryEnabled ? '1' : '0'}`,
      '--', process.execPath, server];
    if (dryRun) console.log('DRY RUN: codex mcp add alexandria ...');
    else {
      const added = run(cli, args);
      if (added.status !== 0) throw new Error(`Could not register Codex MCP: ${added.stderr || added.stdout}`);
      console.log('Registered Alexandria MCP in Codex');
    }
  } else console.log('Alexandria MCP is already registered in Codex; left its MCP entry unchanged');
  installInstruction(path.join(HOME, '.codex', 'AGENTS.md'), renderPrompt(vault, 'Codex'), dryRun);
}

function configureClaude(server, vault, dryRun) {
  const cli = 'claude';
  if (!executableAvailable(cli)) throw new Error('Claude Code CLI was not found. Install it, or choose another client.');
  const list = run(cli, ['mcp', 'list']);
  if (!list.stdout.toLowerCase().includes('alexandria')) {
    const args = ['mcp', 'add', '--scope', 'user',
      '-e', `ALEXANDRIA_VAULT_DIR=${vault}`,
      '-e', 'ALEXANDRIA_NAMESPACE=Claude',
      '-e', `ALEXANDRIA_INDEX_DB=${INDEX_DB}`,
      '-e', `ALEXANDRIA_TELEMETRY=${telemetryEnabled ? '1' : '0'}`,
      'alexandria', '--', process.execPath, server];
    if (dryRun) console.log('DRY RUN: claude mcp add --scope user alexandria ...');
    else {
      const added = run(cli, args);
      if (added.status !== 0) throw new Error(`Could not register Claude Code MCP: ${added.stderr || added.stdout}`);
      console.log('Registered Alexandria MCP in Claude Code');
    }
  } else console.log('Alexandria MCP is already registered in Claude Code; left its MCP entry unchanged');
  installInstruction(path.join(HOME, '.claude', 'CLAUDE.md'), renderPrompt(vault, 'Claude Code'), dryRun);
}

function configureGemini(server, vault, dryRun) {
  const settings = path.join(HOME, '.gemini', 'settings.json');
  writeJson(settings, config => {
    if (!config.mcpServers || typeof config.mcpServers !== 'object') config.mcpServers = {};
    config.mcpServers.alexandria = {
      command: process.execPath,
      args: [server],
      env: { ALEXANDRIA_VAULT_DIR: vault, ALEXANDRIA_NAMESPACE: 'Gemini CLI', ALEXANDRIA_INDEX_DB: INDEX_DB, ALEXANDRIA_TELEMETRY: telemetryEnabled ? '1' : '0' },
    };
  }, dryRun);
  installInstruction(path.join(HOME, '.gemini', 'GEMINI.md'), renderPrompt(vault, 'Gemini CLI'), dryRun);
}

function copyServer(dryRun) {
  if (!fs.existsSync(path.join(SOURCE, 'server.js')) || !fs.existsSync(path.join(SOURCE, 'lib', 'kernel.js'))) {
    throw new Error('The package is incomplete: alexandria-mcp/server.js or lib/kernel.js is missing.');
  }
  if (dryRun) {
    console.log(`DRY RUN: copy MCP server to ${INSTALL_DIR}`);
    return;
  }
  fs.mkdirSync(path.join(INSTALL_DIR, 'lib'), { recursive: true });
  const files = ['server.js', 'telemetry-summary.js', 'telemetry-hook.js', 'package.json', 'package-lock.json', 'AGENTS.md'];
  function collect(dir, allFiles = false) {
    for (const item of fs.readdirSync(path.join(SOURCE,dir), {withFileTypes:true})) {
      const rel = path.join(dir,item.name);
      if (item.isDirectory()) collect(rel, allFiles);
      else if (item.isFile() && (allFiles || /\.(js|json)$/.test(item.name))) files.push(rel);
    }
  }
  collect('lib');
  collect('bin', true);
  collect('http');
  collect('web', true);
  for (const relative of files) {
    const source = path.join(SOURCE,relative);
    if (!fs.existsSync(source)) continue;
    const target = path.join(INSTALL_DIR, relative === 'AGENTS.md' ? 'AGENTS.alexandria.md' : relative);
    fs.mkdirSync(path.dirname(target),{recursive:true}); backup(target); fs.copyFileSync(source,target);
  }
  console.log(`Installed MCP server in ${INSTALL_DIR}`);
}

function initialize(vault, agent, dryRun) {
  if (dryRun) {
    console.log(`DRY RUN: initialize vault ${vault} and index ${INDEX_DB}`);
    return;
  }
  fs.mkdirSync(vault, { recursive: true });
  const result = run(process.execPath, [path.join(INSTALL_DIR, 'server.js'), '--init'], {
    env: { ...process.env, ALEXANDRIA_VAULT_DIR: vault, ALEXANDRIA_NAMESPACE: agent, ALEXANDRIA_INDEX_DB: INDEX_DB, ALEXANDRIA_TELEMETRY: telemetryEnabled ? '1' : '0' },
  });
  if (result.status !== 0) throw new Error(`Vault initialization failed: ${result.stderr || result.stdout}`);
  process.stdout.write(result.stdout);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  telemetryEnabled = args.telemetry === true;
  if (args.help) { console.log(usage()); return; }
  if (Number(process.versions.node.split('.')[0]) < 24) throw new Error('Node.js 24 or newer is required (built-in SQLite/FTS5).');
  if (!args.vault) throw new Error('--vault is required and must point to the Obsidian vault.');
  if (!path.isAbsolute(args.vault)) throw new Error(`Vault path must be absolute: ${args.vault}`);
  const vault = path.resolve(args.vault);

  const supported = ['codex', 'cursor', 'claude-code', 'gemini-cli'];
  const selected = args.client === 'all' ? supported : [args.client];
  if (selected.some(client => !supported.includes(client))) throw new Error(`Unsupported client. Choose ${supported.join(', ')}, or all.`);
  if (!args.dryRun && !fs.existsSync(path.join(SOURCE, 'server.js'))) throw new Error('Run the installer from the repository directory.');

  console.log(`Vault: ${vault}`);
  console.log(`Clients: ${selected.join(', ')}`);
  copyServer(args.dryRun);
  initialize(vault, 'Alexandria', args.dryRun);

  const installable = selected.filter(client => {
    const cli = client === 'codex' ? 'codex' : client === 'claude-code' ? 'claude' : null;
    if (!cli || executableAvailable(cli)) return true;
    if (args.client !== 'all') throw new Error(`${cli} CLI was not found. Install it, or choose another client.`);
    console.log(`Skipping ${client}: ${cli} CLI was not found`);
    return false;
  });
  for (const client of installable) {
    if (client === 'codex') configureCodex(path.join(INSTALL_DIR, 'server.js'), vault, args.dryRun);
    else if (client === 'cursor') cursorConfig(path.join(INSTALL_DIR, 'server.js'), vault, args.dryRun);
    else if (client === 'claude-code') configureClaude(path.join(INSTALL_DIR, 'server.js'), vault, args.dryRun);
    else if (client === 'gemini-cli') configureGemini(path.join(INSTALL_DIR, 'server.js'), vault, args.dryRun);
  }
  console.log('\nRestart or reload the selected client, open a new chat, and ask it to run vault_stats.');
}

try { main(); }
catch (error) { console.error(`Alexandria installer: ${error.message}`); process.exitCode = 1; }
