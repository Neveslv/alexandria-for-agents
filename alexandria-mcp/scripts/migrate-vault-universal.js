#!/usr/bin/env node
/**
 * Migrate AI Storage from agent namespaces to root categories.
 * Dry-run: node scripts/migrate-vault-universal.js
 * Apply:   node scripts/migrate-vault-universal.js --apply
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const VAULT = process.env.ALEXANDRIA_VAULT_DIR || path.join(process.env.HOME, 'AI Storage');
const APPLY = process.argv.includes('--apply');
const WRITE_CATEGORIES = new Set([
  'concepts', 'entities', 'decisions', 'sessions', 'projects', 'patterns',
  'tools', 'postmortems', 'research', 'plans',
]);
const LEGACY_NS = new Set(['Codex', 'Nitro', 'shared']);
const CATEGORY_ALIASES = {
  daily: 'sessions',
  logs: 'sessions',
  library: 'tools',
  wiki: null, // handled specially
};

const stats = {
  copied: 0,
  collisions: 0,
  skipped: 0,
  rawArchived: 0,
  linkRewrites: 0,
  provenanceAdded: 0,
  errors: [],
};

function ensureDir(dir) {
  if (!APPLY) return;
  fs.mkdirSync(dir, { recursive: true });
}

function readText(filePath) {
  return fs.readFileSync(filePath, 'utf8');
}

function writeText(filePath, content) {
  if (!APPLY) return;
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, content);
}

function parseFrontmatter(markdown) {
  if (!markdown.startsWith('---')) return { meta: {}, body: markdown, hasFm: false };
  const end = markdown.indexOf('\n---', 3);
  if (end === -1) return { meta: {}, body: markdown, hasFm: false };
  const block = markdown.slice(3, end).trim();
  const after = markdown.indexOf('\n', end + 4);
  const body = after === -1 ? '' : markdown.slice(after + 1);
  const meta = {};
  for (const line of block.split(/\r?\n/)) {
    const m = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!m) continue;
    meta[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
  }
  return { meta, body, hasFm: true, fmEnd: end };
}

function upsertFrontmatter(markdown, updates) {
  const { meta, body, hasFm } = parseFrontmatter(markdown);
  const merged = { ...meta, ...updates };
  // Preserve order: title, category, agent, source, then rest
  const preferred = ['title', 'category', 'agent', 'source', 'permalink', 'aliases', 'type', 'tags', 'links', 'created', 'modified', 'status', 'kind'];
  const keys = [...preferred.filter(k => merged[k] != null && merged[k] !== ''), ...Object.keys(merged).filter(k => !preferred.includes(k))];
  const lines = keys.map(k => {
    const v = merged[k];
    if (v.startsWith('[') || v.startsWith('{')) return `${k}: ${v}`;
    if (/[:#]|^\s|\s$/.test(v) || v.includes('"')) return `${k}: "${String(v).replace(/"/g, '\\"')}"`;
    return `${k}: ${v}`;
  });
  let out = `---\n${lines.join('\n')}\n---\n`;
  const cleanBody = hasFm ? body.replace(/^\n*/, '\n') : `\n${markdown.replace(/^\n*/, '')}`;
  out += cleanBody.startsWith('\n') ? cleanBody : `\n${cleanBody}`;
  return out;
}

function walkMd(dir, acc = []) {
  if (!fs.existsSync(dir)) return acc;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walkMd(full, acc);
    else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) acc.push(full);
  }
  return acc;
}

function mapSource(relFromNs, agent) {
  // relFromNs: relative to Codex|Nitro|shared
  const parts = relFromNs.split(path.sep);
  const fileName = parts[parts.length - 1];

  // Nitro/raw → _archive/raw
  if (agent === 'Nitro' && parts[0] === 'raw') {
    return { kind: 'raw', destRel: path.join('_archive', 'raw', fileName) };
  }

  // hot.md under namespace → skip copy (handled separately)
  if (fileName === 'hot.md') {
    return { kind: 'hot', destRel: null };
  }

  // Nitro/wiki/<category>/file
  if (agent === 'Nitro' && parts[0] === 'wiki') {
    if (parts.length === 2 && fileName === 'hot.md') return { kind: 'hot', destRel: null };
    const cat = CATEGORY_ALIASES[parts[1]] || parts[1];
    if (!WRITE_CATEGORIES.has(cat)) {
      return { kind: 'skip', reason: `unknown wiki category ${parts[1]}`, destRel: null };
    }
    return { kind: 'note', category: cat, slug: fileName, destRel: path.join(cat, fileName) };
  }

  // Nitro/library → tools
  if (agent === 'Nitro' && parts[0] === 'library') {
    return { kind: 'note', category: 'tools', slug: fileName, destRel: path.join('tools', fileName) };
  }

  // Standard: <category>/file or loose file
  if (parts.length === 1) {
    // Loose under namespace root → sessions
    return { kind: 'note', category: 'sessions', slug: fileName, destRel: path.join('sessions', fileName) };
  }

  let cat = parts[0];
  cat = CATEGORY_ALIASES[cat] || cat;
  if (!WRITE_CATEGORIES.has(cat)) {
    return { kind: 'skip', reason: `unknown category ${parts[0]}`, destRel: null };
  }
  // Nested deeper than category/file → flatten to category/basename
  return { kind: 'note', category: cat, slug: fileName, destRel: path.join(cat, fileName) };
}

function uniqueDest(destRel, agent) {
  const destAbs = path.join(VAULT, destRel);
  if (!fs.existsSync(destAbs) && !plannedDests.has(destRel)) {
    plannedDests.add(destRel);
    return { destRel, collided: false };
  }
  const ext = path.extname(destRel);
  const base = destRel.slice(0, -ext.length);
  const renamed = `${base}-from-${agent}${ext}`;
  plannedDests.add(renamed);
  return { destRel: renamed, collided: true };
}

const plannedDests = new Set();
const pathMap = new Map(); // old wikilink/path → new path without .md

function registerPathMap(agent, relFromNs, newDestRel) {
  const oldFull = `${agent}/${relFromNs}`.replace(/\\/g, '/');
  const newWithoutExt = newDestRel.replace(/\.md$/i, '').replace(/\\/g, '/');
  pathMap.set(oldFull, newWithoutExt);
  pathMap.set(oldFull.replace(/\.md$/i, ''), newWithoutExt);
  // Also map without extension variants
  const oldNoExt = oldFull.replace(/\.md$/i, '');
  pathMap.set(oldNoExt, newWithoutExt);
}

function rewriteWikilinks(content) {
  let count = 0;
  const out = content.replace(/\[\[([^\]|#]+)(#[^\]|]+)?(\|[^\]]+)?\]\]/g, (full, target, hash = '', alias = '') => {
    const trimmed = target.trim();
    // Match Codex/... Nitro/... shared/...
    const m = trimmed.match(/^(Codex|Nitro|shared)\/(.+)$/i);
    if (!m) return full;
    const ns = m[1] === 'codex' || m[1] === 'Codex' ? (m[1][0] === 'c' ? 'Codex' : m[1]) : m[1];
    // Normalize namespace casing
    const nsNorm = LEGACY_NS.has(m[1]) ? m[1] : (m[1].toLowerCase() === 'codex' ? 'Codex' : m[1].toLowerCase() === 'nitro' ? 'Nitro' : m[1].toLowerCase() === 'shared' ? 'shared' : m[1]);
    const rest = m[2].replace(/\.md$/i, '');
    const key = `${nsNorm}/${rest}`;
    const keyWithMd = `${nsNorm}/${rest}.md`;
    let mapped = pathMap.get(key) || pathMap.get(keyWithMd) || pathMap.get(`${nsNorm}/${m[2]}`);
    if (!mapped) {
      // Heuristic: drop namespace, keep category/slug
      const parts = rest.split('/');
      if (parts[0] === 'wiki' && parts.length >= 3) {
        mapped = `${parts[1]}/${parts.slice(2).join('/')}`;
      } else if (parts[0] === 'library') {
        mapped = `tools/${parts.slice(1).join('/')}`;
      } else if (parts[0] === 'raw') {
        mapped = `_archive/raw/${parts.slice(1).join('/')}`;
      } else {
        mapped = rest;
      }
    }
    count += 1;
    return `[[${mapped}${hash || ''}${alias || ''}]]`;
  });
  stats.linkRewrites += count;
  return out;
}

function agentSource(agent) {
  if (agent === 'Codex') return 'codex';
  if (agent === 'Nitro') return 'nitro';
  if (agent === 'shared') return 'shared';
  return agent.toLowerCase();
}

function migrateNote(srcAbs, agent, relFromNs) {
  const mapping = mapSource(relFromNs, agent);
  if (mapping.kind === 'skip') {
    stats.skipped += 1;
    console.log(`SKIP ${agent}/${relFromNs}: ${mapping.reason}`);
    return;
  }
  if (mapping.kind === 'hot') {
    stats.skipped += 1;
    return;
  }
  if (mapping.kind === 'raw') {
    const destAbs = path.join(VAULT, mapping.destRel);
    ensureDir(path.dirname(destAbs));
    if (APPLY) fs.copyFileSync(srcAbs, destAbs);
    registerPathMap(agent, relFromNs, mapping.destRel);
    stats.rawArchived += 1;
    console.log(`RAW  ${agent}/${relFromNs} → ${mapping.destRel}`);
    return;
  }

  const { destRel, collided } = uniqueDest(mapping.destRel, agent);
  if (collided) stats.collisions += 1;

  let content = readText(srcAbs);
  const { meta } = parseFrontmatter(content);
  const updates = {};
  if (!meta.agent) {
    updates.agent = agent === 'shared' ? 'shared' : agent;
    stats.provenanceAdded += 1;
  }
  if (!meta.source) {
    updates.source = agentSource(agent);
  }
  if (!meta.category && mapping.category) {
    updates.category = mapping.category;
  }
  if (collided) {
    const aliases = meta.aliases ? meta.aliases : '';
    const slugBase = path.basename(mapping.destRel, '.md');
    const aliasList = aliases.startsWith('[')
      ? aliases.replace(/\]\s*$/, `, "${slugBase}"]`)
      : `["${slugBase}"]`;
    updates.aliases = aliasList;
  }

  if (Object.keys(updates).length) {
    content = upsertFrontmatter(content, updates);
  }

  writeText(path.join(VAULT, destRel), content);
  registerPathMap(agent, relFromNs, destRel);
  stats.copied += 1;
  console.log(`${collided ? 'COLL' : 'COPY'} ${agent}/${relFromNs} → ${destRel}`);
}

function collectJobs() {
  const jobs = [];
  for (const agent of ['Codex', 'Nitro', 'shared']) {
    const root = path.join(VAULT, agent);
    if (!fs.existsSync(root)) continue;
    for (const file of walkMd(root)) {
      const rel = path.relative(root, file);
      jobs.push({ srcAbs: file, agent, relFromNs: rel });
    }
  }
  return jobs;
}

function rewriteAllActiveNotes() {
  for (const cat of WRITE_CATEGORIES) {
    const dir = path.join(VAULT, cat);
    if (!fs.existsSync(dir)) continue;
    for (const file of walkMd(dir)) {
      const before = readText(file);
      const after = rewriteWikilinks(before);
      if (after !== before) {
        writeText(file, after);
        console.log(`LINK ${path.relative(VAULT, file)}`);
      }
    }
  }
  const hotPath = path.join(VAULT, 'hot.md');
  if (fs.existsSync(hotPath)) {
    const before = readText(hotPath);
    const after = rewriteWikilinks(before);
    if (after !== before) writeText(hotPath, after);
  }
}

function mergeNitroHot() {
  const nitroHot = path.join(VAULT, 'Nitro', 'hot.md');
  const rootHot = path.join(VAULT, 'hot.md');
  if (!fs.existsSync(nitroHot) || !fs.existsSync(rootHot)) return;
  const nitro = readText(nitroHot);
  const useful = [];
  for (const line of nitro.split(/\r?\n/)) {
    if (/\[\[/.test(line) && !/adicione|vão aqui|placeholder/i.test(line)) {
      useful.push(line);
    }
  }
  if (!useful.length) {
    console.log('HOT  Nitro hot has no unique useful lines (skip merge)');
    return;
  }
  let root = readText(rootHot);
  if (!root.includes('## Migrated from Nitro hot')) {
    root = `${root.trim()}\n\n## Migrated from Nitro hot\n${useful.join('\n')}\n`;
    writeText(rootHot, root);
    console.log(`HOT  merged ${useful.length} lines from Nitro/hot.md`);
  }
}

function archiveNamespaces() {
  const archiveRoot = path.join(VAULT, '_archive', 'namespaces');
  ensureDir(archiveRoot);
  for (const agent of ['Codex', 'Nitro', 'shared']) {
    const src = path.join(VAULT, agent);
    const dest = path.join(archiveRoot, agent);
    if (!fs.existsSync(src)) continue;
    if (fs.existsSync(dest)) {
      console.log(`ARCHIVE skip ${agent}: already at ${dest}`);
      continue;
    }
    if (APPLY) {
      fs.renameSync(src, dest);
    }
    console.log(`ARCHIVE ${agent}/ → _archive/namespaces/${agent}/`);
  }
}

function ensureCategoryDirs() {
  for (const cat of WRITE_CATEGORIES) {
    ensureDir(path.join(VAULT, cat));
  }
  ensureDir(path.join(VAULT, '_archive', 'namespaces'));
  ensureDir(path.join(VAULT, '_archive', 'raw'));
}

function main() {
  console.log(`Vault: ${VAULT}`);
  console.log(`Mode: ${APPLY ? 'APPLY' : 'DRY-RUN'}`);
  if (!fs.existsSync(VAULT)) {
    console.error('Vault not found');
    process.exit(1);
  }

  ensureCategoryDirs();
  const jobs = collectJobs();
  console.log(`Found ${jobs.length} markdown files under namespaces`);

  for (const job of jobs) {
    try {
      migrateNote(job.srcAbs, job.agent, job.relFromNs);
    } catch (err) {
      stats.errors.push(`${job.agent}/${job.relFromNs}: ${err.message}`);
      console.error('ERR', job.agent, job.relFromNs, err.message);
    }
  }

  mergeNitroHot();
  rewriteAllActiveNotes();

  if (APPLY) {
    archiveNamespaces();
  } else {
    console.log('(dry-run) would archive Codex/Nitro/shared → _archive/namespaces/');
  }

  console.log('\n=== Summary ===');
  console.log(JSON.stringify(stats, null, 2));
  console.log(`pathMap entries: ${pathMap.size}`);
}

main();
