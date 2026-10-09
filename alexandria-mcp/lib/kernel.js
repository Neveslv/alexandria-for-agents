#!/usr/bin/env node
/**
 * Alexandria MCP Server v2.0 — Real Second Brain for Codex
 *
 * Full-featured knowledge vault with:
 * - Hybrid search (FTS5 + semantic embeddings + local cosine)
 * - Ultra-fast vault_recall with hot.md context injection
 * - Query expansion (local aliases + LLM via LLMaaS, cached)
 * - Write-back (vault_write, vault_auto_save)
 * - Local SQLite index for Codex over a Markdown/Obsidian vault
 *
 * Protocol: JSON-RPC 2.0 over stdio (MCP)
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

// ─── Config ─────────────────────────────────────────────────────────────────
const HOME = process.env.HOME || os.homedir();

function resolveConfiguredPath(value, fallback) {
  if (!value) return fallback;
  const expanded = value.startsWith('~/') ? path.join(HOME, value.slice(2)) : value;
  return path.resolve(expanded);
}

const VAULT_DIR = resolveConfiguredPath(
  process.env.ALEXANDRIA_VAULT_DIR,
  path.join(HOME, 'Documents/AI_memory/graph_memory/Alexandria/wiki'),
);
const VAULT_ROOT = path.join(VAULT_DIR, '..');
const INDEX_DB = resolveConfiguredPath(
  process.env.ALEXANDRIA_INDEX_DB,
  path.join(HOME, '.codex/mcp-servers/alexandria/.vault-index.db'),
);
const SETTINGS_PATH = resolveConfiguredPath(
  process.env.ALEXANDRIA_SETTINGS_PATH,
  path.join(HOME, '.codex/mcp-servers/alexandria/settings.json'),
);
const EXPANSION_CACHE_PATH = resolveConfiguredPath(
  process.env.ALEXANDRIA_EXPANSION_CACHE,
  path.join(HOME, '.codex/mcp-servers/alexandria/.expansion-cache.json'),
);
const WRITE_CATEGORIES = new Set([
  'concepts', 'entities', 'decisions', 'sessions', 'projects', 'patterns',
  'tools', 'postmortems', 'research', 'plans',
]);
const LEGACY_NAMESPACES = new Set(['Codex', 'Nitro', 'shared']);
const ARCHIVE_ROOT = '_archive';

function getSettings() {
  try { return JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf8')); } catch { return {}; }
}

function escSql(s) {
  return String(s || '').replace(/'/g, "''");
}

function clampInteger(value, fallback, min, max) {
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(n, min), max);
}

function isInsideDir(parent, child) {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return rel === '' || (!!rel && !rel.startsWith('..') && !path.isAbsolute(rel));
}

function normalizeCategory(category, fallback = 'concepts') {
  const cat = String(category || fallback).trim();
  return WRITE_CATEGORIES.has(cat) ? cat : null;
}

function cleanInline(value, fallback = 'Untitled') {
  const text = String(value || '').replace(/[\r\n]/g, ' ').trim();
  return text || fallback;
}

function slugify(value) {
  return cleanInline(value)
    .replace(/[^a-zA-Z0-9À-ÿ\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    || 'Untitled';
}

function cleanNamespace(value) {
  const namespace = cleanInline(value, '')
    .replace(/[^a-zA-Z0-9À-ÿ _-]/g, '')
    .trim()
    .replace(/\s+/g, ' ');
  return namespace || '';
}

/** @deprecated Path prefix ignored; ALEXANDRIA_NAMESPACE is provenance-only (agent). */
function getWriteNamespace() {
  return '';
}

function getWriteAgent(args = {}) {
  const fromArgs = cleanNamespace(args.agent || '');
  if (fromArgs) return fromArgs;
  return cleanNamespace(process.env.ALEXANDRIA_NAMESPACE || '');
}

function normalizeStringArray(value) {
  if (!Array.isArray(value)) return [];
  return value.map(v => cleanInline(v, '')).filter(Boolean).slice(0, 50);
}

function defaultHotContext() {
  return [
    '---',
    'type: hot-context',
    '---',
    '# Projetos Ativos',
    '',
    '> Last updated: never',
    '',
    '## Recent Activity',
    '',
  ].join('\n');
}

function ensureVaultReady() {
  fs.mkdirSync(VAULT_DIR, { recursive: true });
  const hotPath = path.join(VAULT_DIR, 'hot.md');
  if (!fs.existsSync(hotPath)) {
    const safeHot = safeVaultWritePath(hotPath);
    if (safeHot) fs.writeFileSync(safeHot, defaultHotContext());
  }

  fs.mkdirSync(path.dirname(INDEX_DB), { recursive: true });
  sqliteExec(`
    CREATE TABLE IF NOT EXISTS pages (
      path TEXT PRIMARY KEY,
      title TEXT,
      category TEXT,
      content TEXT,
      summary TEXT,
      modified TEXT,
      links INTEGER DEFAULT 0,
      permalink TEXT,
      note_type TEXT,
      tags TEXT,
      metadata TEXT,
      checksum TEXT,
      size INTEGER DEFAULT 0
    );
    CREATE VIRTUAL TABLE IF NOT EXISTS pages_fts USING fts5(
      path UNINDEXED,
      title,
      category,
      content,
      summary
    );
    CREATE TABLE IF NOT EXISTS embeddings (
      path TEXT PRIMARY KEY,
      vector TEXT
    );
    CREATE TABLE IF NOT EXISTS observations (
      id TEXT PRIMARY KEY,
      path TEXT,
      title TEXT,
      category TEXT,
      content TEXT,
      tags TEXT,
      context TEXT,
      permalink TEXT,
      modified TEXT
    );
    CREATE TABLE IF NOT EXISTS relations (
      id TEXT PRIMARY KEY,
      path TEXT,
      title TEXT,
      relation_type TEXT,
      target TEXT,
      context TEXT,
      permalink TEXT,
      modified TEXT
    );
  `);
  ensurePageColumns();

  indexMarkdownVault();
}

// ─── SQLite helper ──────────────────────────────────────────────────────────
function sqlite(sql) {
  try {
    return execFileSync('sqlite3', ['-json', INDEX_DB], {
      input: sql, encoding: 'utf8', timeout: 15000, maxBuffer: 50 * 1024 * 1024,
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
  } catch (e) { return null; }
}

function sqliteExec(sql) {
  try {
    execFileSync('sqlite3', [INDEX_DB], {
      input: sql, encoding: 'utf8', timeout: 15000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return true;
  } catch { return false; }
}

function sqliteRows(sql) {
  const raw = sqlite(sql);
  if (!raw) return [];
  try { return JSON.parse(raw); } catch { return []; }
}

function ensurePageColumns() {
  for (const [name, type] of [
    ['permalink', 'TEXT'],
    ['note_type', 'TEXT'],
    ['tags', 'TEXT'],
    ['metadata', 'TEXT'],
    ['checksum', 'TEXT'],
    ['size', 'INTEGER DEFAULT 0'],
  ]) {
    sqliteExec(`ALTER TABLE pages ADD COLUMN ${name} ${type};`);
  }
}

function stripFrontmatter(markdown) {
  if (!markdown.startsWith('---')) return markdown;
  const end = markdown.indexOf('\n---', 3);
  if (end === -1) return markdown;
  const after = markdown.indexOf('\n', end + 4);
  return after === -1 ? '' : markdown.slice(after + 1);
}

function frontmatterValue(markdown, key) {
  const match = markdown.match(new RegExp(`^${key}:\\s*"?([^"\\n]+)"?\\s*$`, 'mi'));
  return match?.[1]?.trim() || '';
}

function frontmatterBlock(markdown) {
  if (!markdown.startsWith('---')) return '';
  const end = markdown.indexOf('\n---', 3);
  if (end === -1) return '';
  return markdown.slice(3, end).trim();
}

function parseScalar(value) {
  return String(value || '')
    .trim()
    .replace(/^['"]|['"]$/g, '')
    .trim();
}

function parseFrontmatter(markdown) {
  const block = frontmatterBlock(markdown);
  const metadata = {};
  if (!block) return metadata;

  for (const line of block.split(/\r?\n/)) {
    const match = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!match) continue;
    const key = match[1].trim();
    const raw = match[2].trim();
    if (raw.startsWith('[') && raw.endsWith(']')) {
      metadata[key] = raw.slice(1, -1)
        .split(',')
        .map(part => parseScalar(part))
        .filter(Boolean);
    } else {
      metadata[key] = parseScalar(raw);
    }
  }
  return metadata;
}

function normalizeTagList(value) {
  if (Array.isArray(value)) return value.map(v => cleanInline(v, '')).filter(Boolean);
  if (typeof value === 'string' && value.trim()) {
    return value.split(',').map(v => cleanInline(v, '')).filter(Boolean);
  }
  return [];
}

function hashShort(value) {
  return crypto.createHash('sha1').update(String(value)).digest('hex').slice(0, 12);
}

function generatePermalink(value) {
  return slugify(value).toLowerCase();
}

function fallbackPermalink(title, relPath) {
  const rel = String(relPath || '').replace(/\.md$/i, '');
  if (rel) {
    return rel.split(/[\\/]+/).map(part => generatePermalink(part)).filter(Boolean).join('/');
  }
  return generatePermalink(title);
}

function extractTrailingContext(text) {
  const match = String(text || '').match(/\s+\(([^()]*)\)\s*$/);
  if (!match) return { text: String(text || '').trim(), context: '' };
  return {
    text: String(text || '').slice(0, match.index).trim(),
    context: cleanInline(match[1], ''),
  };
}

function extractTags(text) {
  const tags = [];
  const cleaned = String(text || '').replace(/(^|\s)#([A-Za-z0-9_-]+)/g, (_, lead, tag) => {
    tags.push(tag);
    return lead;
  }).replace(/\s+/g, ' ').trim();
  return { text: cleaned, tags };
}

function parseSemanticMarkdown(markdown, relPath = '', filePath = '') {
  const metadata = parseFrontmatter(markdown);
  const title = titleFromMarkdown(markdown, filePath || relPath);
  const category = categoryFromRelPath(relPath || path.basename(filePath || ''), markdown);
  const noteType = cleanInline(metadata.type || 'note', 'note');
  const tags = normalizeTagList(metadata.tags);
  const permalink = cleanInline(metadata.permalink || generatePermalink(title), '');
  const observations = [];
  const relations = [];
  const body = stripFrontmatter(markdown);

  for (const line of body.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!/^[-*]\s+/.test(trimmed)) continue;

    const observationMatch = trimmed.match(/^[-*]\s+\[([^\]\(\)]+)\]\s+(.+)$/);
    if (observationMatch) {
      const obsCategory = cleanInline(observationMatch[1], '').toLowerCase();
      if (['', ' ', 'x', 'X', '-'].includes(obsCategory)) continue;
      const withContext = extractTrailingContext(observationMatch[2]);
      const withTags = extractTags(withContext.text);
      const content = cleanInline(withTags.text, '');
      if (!content) continue;
      const idSeed = `${relPath}:observation:${obsCategory}:${content}:${withContext.context}`;
      observations.push({
        id: hashShort(idSeed),
        path: relPath,
        title,
        category: obsCategory,
        content,
        tags: [...new Set([...tags, ...withTags.tags])],
        context: withContext.context,
        permalink: `${permalink}/observations/${obsCategory}/${hashShort(content)}`,
      });
      continue;
    }

    const relationMatch = trimmed.match(/^[-*]\s+(?:(.*?)\s+)?\[\[([^\]]+)\]\]\s*(?:\(([^)]*)\))?/);
    if (relationMatch) {
      const relationType = cleanInline(relationMatch[1] || 'links_to', 'links_to')
        .toLowerCase()
        .replace(/\s+/g, '_');
      const target = cleanInline(relationMatch[2], '');
      if (!target) continue;
      const context = cleanInline(relationMatch[3] || '', '');
      const idSeed = `${relPath}:relation:${relationType}:${target}:${context}`;
      relations.push({
        id: hashShort(idSeed),
        path: relPath,
        title,
        relation_type: relationType,
        target,
        context,
        permalink: `${permalink}/${relationType}/${generatePermalink(target)}`,
      });
    }
  }

  const explicitRelationTargets = new Set(relations.map(r => r.target));
  for (const match of body.matchAll(/\[\[([^\]]+)\]\]/g)) {
    const target = cleanInline(match[1], '');
    if (!target || explicitRelationTargets.has(target)) continue;
    const idSeed = `${relPath}:relation:links_to:${target}`;
    relations.push({
      id: hashShort(idSeed),
      path: relPath,
      title,
      relation_type: 'links_to',
      target,
      context: '',
      permalink: `${permalink}/links_to/${generatePermalink(target)}`,
    });
  }

  return {
    metadata,
    title,
    category,
    noteType,
    tags,
    permalink,
    observations,
    relations,
  };
}

function titleFromMarkdown(markdown, filePath) {
  const fmTitle = frontmatterValue(markdown, 'title');
  if (fmTitle) return cleanInline(fmTitle);

  const body = stripFrontmatter(markdown);
  const heading = body.match(/^#\s+(.+)$/m);
  if (heading) return cleanInline(heading[1]);

  return cleanInline(path.basename(filePath, '.md'));
}

function categoryFromRelPath(relPath, markdown) {
  const fmCategory = frontmatterValue(markdown, 'category');
  if (fmCategory) return cleanInline(fmCategory, 'concepts');

  const parts = String(relPath || '').split('/').filter(Boolean);
  if (!parts.length) return 'concepts';
  if (parts[0] === 'hot.md') return 'hot';

  // _archive/namespaces/{Codex|Nitro|shared}/<category>/...
  if (parts[0] === ARCHIVE_ROOT) {
    if (parts[1] === 'namespaces' && LEGACY_NAMESPACES.has(parts[2]) && parts[3]) {
      return cleanInline(parts[3], 'concepts');
    }
    if (parts[1] === 'raw') return 'archive';
    return 'archive';
  }

  // Legacy live trees (pre-migration): Codex|Nitro|shared/<category>/...
  if (LEGACY_NAMESPACES.has(parts[0]) && parts[1]) return cleanInline(parts[1], 'concepts');

  // Universal taxonomy: <category>/...
  if (parts[0] !== 'hot.md') return cleanInline(parts[0], 'concepts');
  return 'concepts';
}

function markdownSummary(markdown) {
  return stripFrontmatter(markdown)
    .replace(/^# .+$/m, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 300);
}

function countWikiLinks(markdown) {
  return (markdown.match(/\[\[[^\]]+\]\]/g) || []).length;
}

function relVaultPath(filePath) {
  return path.relative(VAULT_DIR, filePath).split(path.sep).join('/');
}

function relVaultRealPath(filePath) {
  try {
    return path.relative(fs.realpathSync(VAULT_DIR), fs.realpathSync(filePath)).split(path.sep).join('/');
  } catch {
    return relVaultPath(filePath);
  }
}

function vaultRelativePath(...parts) {
  return parts.filter(Boolean).join('/');
}

function walkMarkdownFiles(dir, acc = []) {
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return acc; }

  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      // Skip archive trees from operational index
      if (entry.name === ARCHIVE_ROOT || entry.name === '.obsidian' || entry.name === '.smart-env') continue;
      walkMarkdownFiles(full, acc);
    } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) {
      acc.push(full);
    }
  }
  return acc;
}

function checksumContent(content) {
  return crypto.createHash('sha256').update(String(content || '')).digest('hex');
}

function sqlJson(value) {
  return escSql(JSON.stringify(value ?? null));
}

function upsertPageIndex({ relPath, title, category, content, summary, modified, links, permalink = '', noteType = 'note', tags = [], metadata = {}, size = 0 }) {
  const safeLimitLinks = clampInteger(links, 0, 0, 100000);
  sqliteExec(`
    INSERT OR REPLACE INTO pages (path, title, category, content, summary, modified, links, permalink, note_type, tags, metadata, checksum, size)
    VALUES ('${escSql(relPath)}', '${escSql(title)}', '${escSql(category)}', '${escSql(content)}', '${escSql(summary)}', '${escSql(modified)}', ${safeLimitLinks}, '${escSql(permalink)}', '${escSql(noteType)}', '${sqlJson(tags)}', '${sqlJson(metadata)}', '${checksumContent(content)}', ${Number(size) || Buffer.byteLength(String(content || ''), 'utf8')});
    INSERT OR REPLACE INTO pages_fts (path, title, category, content, summary)
    VALUES ('${escSql(relPath)}', '${escSql(title)}', '${escSql(category)}', '${escSql(content)}', '${escSql(summary)}');
  `);
}

function indexStructuredItems({ relPath, parsed, modified }) {
  sqliteExec(`
    DELETE FROM observations WHERE path = '${escSql(relPath)}';
    DELETE FROM relations WHERE path = '${escSql(relPath)}';
  `);
  for (const obs of parsed.observations) {
    sqliteExec(`
      INSERT OR REPLACE INTO observations (id, path, title, category, content, tags, context, permalink, modified)
      VALUES ('${escSql(obs.id)}', '${escSql(relPath)}', '${escSql(parsed.title)}', '${escSql(obs.category)}', '${escSql(obs.content)}', '${sqlJson(obs.tags)}', '${escSql(obs.context)}', '${escSql(obs.permalink)}', '${escSql(modified)}');
    `);
  }
  for (const rel of parsed.relations) {
    sqliteExec(`
      INSERT OR REPLACE INTO relations (id, path, title, relation_type, target, context, permalink, modified)
      VALUES ('${escSql(rel.id)}', '${escSql(relPath)}', '${escSql(parsed.title)}', '${escSql(rel.relation_type)}', '${escSql(rel.target)}', '${escSql(rel.context)}', '${escSql(rel.permalink)}', '${escSql(modified)}');
    `);
  }
}

function recordIndexFailure(relPath, error) {
  INDEX_FAILURES.set(relPath || 'unknown', {
    message: error?.message || String(error || 'unknown error'),
    ts: new Date().toISOString(),
  });
}

function clearIndexFailure(relPath) {
  INDEX_FAILURES.delete(relPath || 'unknown');
}

function applyEffectivePermalink(parsed, relPath) {
  const explicit = cleanInline(parsed.metadata?.permalink || '', '');
  if (explicit) return parsed;

  const base = parsed.permalink;
  const collision = sqliteRows(`SELECT path FROM pages WHERE permalink = '${escSql(base)}' AND path != '${escSql(relPath)}' LIMIT 1;`)[0];
  if (!collision) return parsed;

  const effective = fallbackPermalink(parsed.title, relPath);
  parsed.permalink = effective;
  for (const obs of parsed.observations) {
    if (obs.permalink.startsWith(`${base}/`)) obs.permalink = `${effective}/${obs.permalink.slice(base.length + 1)}`;
  }
  for (const rel of parsed.relations) {
    if (rel.permalink.startsWith(`${base}/`)) rel.permalink = `${effective}/${rel.permalink.slice(base.length + 1)}`;
  }
  return parsed;
}

function indexMarkdownFile(filePath, existingContent = null, existingStat = null) {
  if (!isInsideDir(VAULT_DIR, filePath)) return null;
  const content = existingContent ?? fs.readFileSync(filePath, 'utf8');
  const relPath = relVaultPath(filePath);
  const stat = existingStat ?? fs.statSync(filePath);
  const parsed = parseSemanticMarkdown(content, relPath, filePath);
  applyEffectivePermalink(parsed, relPath);
  const summary = markdownSummary(content);
  upsertPageIndex({
    relPath,
    title: parsed.title,
    category: parsed.category,
    content,
    summary,
    modified: stat.mtime.toISOString(),
    links: countWikiLinks(content),
    permalink: parsed.permalink,
    noteType: parsed.noteType,
    tags: parsed.tags,
    metadata: parsed.metadata,
    size: stat.size,
  });
  indexStructuredItems({ relPath, parsed, modified: stat.mtime.toISOString() });
  LOCAL_EMBEDDING_STORE.set(relPath, createLocalEmbedding([
    parsed.title,
    parsed.category,
    summary,
    parsed.observations.map(o => o.content).join(' '),
  ].join(' ')));
  clearIndexFailure(relPath);
  return relPath;
}

function deleteIndexedPath(relPath) {
  sqliteExec(`
    DELETE FROM pages WHERE path = '${escSql(relPath)}';
    DELETE FROM pages_fts WHERE path = '${escSql(relPath)}';
    DELETE FROM observations WHERE path = '${escSql(relPath)}';
    DELETE FROM relations WHERE path = '${escSql(relPath)}';
  `);
  LOCAL_EMBEDDING_STORE.delete(relPath);
}

function indexMarkdownVault() {
  sqliteExec('DELETE FROM pages; DELETE FROM pages_fts; DELETE FROM observations; DELETE FROM relations;');
  LOCAL_EMBEDDING_STORE.clear();

  const files = walkMarkdownFiles(VAULT_DIR);
  for (const filePath of files) {
    try {
      indexMarkdownFile(filePath);
    } catch (error) {
      recordIndexFailure(relVaultPath(filePath), error);
    }
  }
}

function syncMarkdownVault() {
  const files = walkMarkdownFiles(VAULT_DIR);
  const seen = new Set();
  const existingRows = new Map(sqliteRows('SELECT path, checksum, size FROM pages;').map(row => [row.path, row]));

  for (const filePath of files) {
    try {
      if (!isInsideDir(VAULT_DIR, filePath)) continue;
      const relPath = relVaultPath(filePath);
      seen.add(relPath);
      const stat = fs.statSync(filePath);
      const existing = existingRows.get(relPath);
      if (existing && Number(existing.size || 0) === stat.size) {
        const content = fs.readFileSync(filePath, 'utf8');
        const checksum = checksumContent(content);
        if (existing.checksum === checksum) continue;
        indexMarkdownFile(filePath, content, stat);
      } else {
        indexMarkdownFile(filePath, null, stat);
      }
    } catch (error) {
      recordIndexFailure(isInsideDir(VAULT_DIR, filePath) ? relVaultPath(filePath) : filePath, error);
    }
  }

  for (const relPath of existingRows.keys()) {
    if (!seen.has(relPath)) deleteIndexedPath(relPath);
  }
}

function refreshVaultIndex() {
  try { syncMarkdownVault(); } catch {}
}

// ─── Embedding Engine ───────────────────────────────────────────────────────
const EMBED_DIM = 192;
const EMBED_STOP = new Set(['and','the','for','that','this','with','from','are','was','were','been',
  'have','has','had','not','but','what','all','can','her','his','one','our','out','you','they','them',
  'will','would','could','should','just','some','than','then','que','com','para','uma','dos','das',
  'mais','como','sobre','entre','por','nos','nas','aos','esse','essa','isso','este','esta']);

const EMBED_ALIASES = {
  ai: ['agent','model','inteligência','inteligente','llm','ml'],
  api: ['interface','client','endpoint','rest','http'],
  auth: ['authentication','authorization','login','sso','oidc'],
  db: ['database','storage','banco','sqlite','postgres'],
  ui: ['frontend','browser','interface','react','component'],
  cli: ['terminal','command','linha','shell'],
  mcp: ['agent','tool','integration','server','protocol','plugin'],
  llm: ['ai','agent','model','language','modelo','gpt','claude','haiku'],
  plugin: ['extension','module','módulo','extensão','mcp'],
  vault: ['memory','knowledge','memória','conhecimento','brain','cérebro','alexandria'],
  obsidian: ['markdown','notes','notas','wiki'],
  react: ['frontend','component','componente','jsx','tsx'],
  memória: ['vault','memory','knowledge','brain','segundo'],
  agente: ['agent','ai','llm','modelo'],
  conhecimento: ['knowledge','vault','memory','grafo','graph'],
  busca: ['search','retrieval','query','encontrar','fts'],
  projeto: ['project','repo','repositório','codebase'],
  decisão: ['decision','adr','escolha','trade-off'],
  crew: ['kanban','task','workspace','squad','workflow','orchestrator'],
  codex: ['openai','ide','terminal','coding','assistant'],
  alexandria: ['vault','knowledge','wiki','memory','segundo cérebro','biblioteca','fts5'],
  segundo: ['brain','cérebro','vault','memory','alexandria'],
  deploy: ['argocd','moonlight','kubernetes','k8s','pipeline'],
  segurança: ['security','vulnerabilidade','owasp','snyk','appsec'],
  teste: ['test','qa','playwright','jest','vitest'],
  dados: ['data','analytics','databricks','sql','pipeline'],
  grafana: ['monitoring','observabilidade','metrics','prometheus'],
  slack: ['mensagem','channel','notification','bot'],
  github: ['pr','pull request','issue','actions','ci'],
};

function embedTokenize(text) {
  return text.toLowerCase()
    .replace(/[^a-záàâãéèêíïóôõöúçñ0-9\s-]/gi, ' ')
    .split(/\s+/)
    .filter(t => t.length > 2 && !EMBED_STOP.has(t))
    .map(t => t.replace(/(ções|mente|ência|ação|ável|ível|ando|endo|indo|ados|idos|adas|idas|ante|ente|ores|ões|ais|eis|es|os|as|s)$/i, '') || t)
    .filter(t => t.length > 2);
}

function embedExpand(tokens) {
  return tokens.flatMap(t => [t, ...(EMBED_ALIASES[t] || [])]);
}

function embedHash(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) h = Math.imul(h ^ str.charCodeAt(i), 16777619) >>> 0;
  return h;
}

function createLocalEmbedding(text) {
  const tokens = embedExpand(embedTokenize(text));
  const vec = new Float64Array(EMBED_DIM);
  for (const t of tokens) {
    const h = embedHash(`t:${t}`);
    vec[h % EMBED_DIM] += (h & 1) ? 1 : -1;
  }
  for (let i = 0; i < tokens.length - 1; i++) {
    const h = embedHash(`b:${tokens[i]}:${tokens[i+1]}`);
    vec[h % EMBED_DIM] += ((h & 1) ? 1 : -1) * 0.65;
  }
  const mag = Math.hypot(...vec);
  if (mag > 0) for (let i = 0; i < EMBED_DIM; i++) vec[i] /= mag;
  return vec;
}

function cosineSim(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom > 0 ? dot / denom : 0;
}

// ─── In-Memory Embedding Store ──────────────────────────────────────────────
const EMBEDDING_STORE = new Map(); // path -> Float64Array (API vectors from SQLite)
const LOCAL_EMBEDDING_STORE = new Map(); // path -> Float64Array (local 192-dim)
const INDEX_FAILURES = new Map(); // relPath -> latest indexing error

function loadEmbeddings() {
  const start = Date.now();
  try {
    const rows = sqliteRows('SELECT path, vector FROM embeddings;');
    for (const row of rows) {
      try {
        const vec = JSON.parse(row.vector);
        if (Array.isArray(vec)) EMBEDDING_STORE.set(row.path, vec);
      } catch {}
    }
    // Also build local embeddings from page titles+summaries for fast matching
    const pages = sqliteRows('SELECT path, title, category, summary FROM pages;');
    for (const p of pages) {
      const text = [p.title, p.category, p.summary].filter(Boolean).join(' ');
      LOCAL_EMBEDDING_STORE.set(p.path, createLocalEmbedding(text));
    }
    log(`loaded ${EMBEDDING_STORE.size} API embeddings + ${LOCAL_EMBEDDING_STORE.size} local embeddings (${Date.now() - start}ms)`);
  } catch (e) { log(`embedding load error: ${e.message}`); }
}

// ─── Semantic Search ────────────────────────────────────────────────────────
function semanticSearch(query, limit = 10) {
  const queryLocalVec = createLocalEmbedding(query);
  const scored = [];

  // Try local embeddings first (always available, fast)
  for (const [pagePath, vector] of LOCAL_EMBEDDING_STORE) {
    const sim = cosineSim(queryLocalVec, vector);
    if (sim > 0.15) scored.push({ path: pagePath, similarity: sim, source: 'local' });
  }

  // Also try API embeddings if same dimensions
  // API embeddings are high-dim (3072), can't compare with local 192-dim query
  // So we use local embedding of query against local embeddings of pages

  scored.sort((a, b) => b.similarity - a.similarity);
  return scored.slice(0, limit);
}

// ─── Stopwords ──────────────────────────────────────────────────────────────
const FTS_STOPWORDS = new Set([
  'que', 'com', 'para', 'uma', 'dos', 'das', 'mais', 'como', 'sobre',
  'entre', 'por', 'nos', 'nas', 'aos', 'esse', 'essa', 'isso', 'este',
  'esta', 'aqui', 'ali', 'assim', 'muito', 'pouco', 'todo', 'toda',
  'cada', 'outro', 'outra', 'mesmo', 'mesma', 'qual', 'quais',
  'ainda', 'depois', 'antes', 'agora', 'sempre', 'nunca', 'onde',
  'como', 'porque', 'porquê', 'pois', 'desde', 'até', 'sem', 'sob',
  'fizemos', 'fizeram', 'fez', 'fazer', 'feito', 'faço', 'faz',
  'tinha', 'temos', 'tenho', 'tem', 'teve', 'eram', 'era',
  'está', 'estão', 'estou', 'estava', 'foram', 'vou', 'vai',
  'pode', 'podem', 'podia', 'podemos', 'seria', 'será',
  'última', 'ultimo', 'primeiro', 'primeira', 'últimos', 'últimas',
  'coisa', 'coisas', 'algo', 'alguém', 'nada', 'tudo',
  'the', 'and', 'for', 'that', 'this', 'with', 'from', 'are', 'was',
  'were', 'been', 'have', 'has', 'had', 'not', 'but', 'what', 'all',
  'can', 'her', 'his', 'one', 'our', 'out', 'you', 'they', 'them',
  'will', 'would', 'could', 'should', 'just', 'some', 'than', 'then',
]);

// ─── LLM Expansion ─────────────────────────────────────────────────────────
const EXPANSION_CACHE = new Map(); // in-memory + persisted to disk
const EXPANSION_TTL = 3600000; // 1h

function loadExpansionCache() {
  try {
    const data = JSON.parse(fs.readFileSync(EXPANSION_CACHE_PATH, 'utf8'));
    const now = Date.now();
    for (const [k, v] of Object.entries(data)) {
      if (now - v.ts < EXPANSION_TTL) EXPANSION_CACHE.set(k, v);
    }
    log(`loaded ${EXPANSION_CACHE.size} cached expansions`);
  } catch {}
}

function saveExpansionCache() {
  try {
    const dir = path.dirname(EXPANSION_CACHE_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const obj = Object.fromEntries(EXPANSION_CACHE);
    fs.writeFileSync(EXPANSION_CACHE_PATH, JSON.stringify(obj));
  } catch {}
}

function callLLMSync(prompt, maxTokens = 200) {
  const settings = getSettings();
  if (settings.allowRemoteExpansion !== true) return null;
  if (!settings.apiKey || !settings.endpoint) return null;

  const payload = JSON.stringify({
    model: 'claude-haiku-4-5',
    max_tokens: maxTokens,
    messages: [{ role: 'user', content: prompt }],
  });

  try {
    new URL(settings.endpoint);
    const authHeader = ['Authorization', `Bearer ${settings.apiKey}`].join(': ');
    const result = execFileSync('curl', [
      '-s', '-X', 'POST', settings.endpoint,
      '-H', 'Content-Type: application/json',
      '-H', authHeader,
      '-d', payload,
      '--max-time', '5',
    ], { encoding: 'utf8', timeout: 8000 });

    const parsed = JSON.parse(result);
    return parsed?.choices?.[0]?.message?.content || parsed?.content?.[0]?.text || null;
  } catch { return null; }
}

function expandQueryLLM(query) {
  const cacheKey = hashShort(query.toLowerCase().trim());
  const cached = EXPANSION_CACHE.get(cacheKey);
  if (cached && Date.now() - cached.ts < EXPANSION_TTL) return cached.terms;

  const prompt = `Expanda esta busca em 5-8 termos de busca alternativos (sinônimos, variações, termos relacionados). Query: "${query}"
Responda APENAS com os termos separados por vírgula, sem explicação. Mix PT-BR e EN.`;

  const response = callLLMSync(prompt, 100);
  if (!response) return [];

  const terms = response.split(/[,\n]/).map(t => t.trim().toLowerCase()).filter(t => t.length > 2 && t.length < 30);

  EXPANSION_CACHE.set(cacheKey, { terms, ts: Date.now() });
  saveExpansionCache();

  return terms;
}

// ─── Query Expansion (local) ───────────────────────────────────────────────
function expandQueryLocal(tokens) {
  const expanded = new Set(tokens.map(t => t.toLowerCase()));
  for (const token of tokens) {
    const lower = token.toLowerCase();
    if (EMBED_ALIASES[lower]) {
      EMBED_ALIASES[lower].forEach(a => expanded.add(a));
    }
    for (const [key, vals] of Object.entries(EMBED_ALIASES)) {
      if (vals.includes(lower)) expanded.add(key);
    }
  }
  return [...expanded];
}

// ─── FTS Search ─────────────────────────────────────────────────────────────
function chunkMarkdown(markdown) {
  const body = stripFrontmatter(markdown);
  const chunks = [];
  let current = [];
  for (const line of body.split(/\r?\n/)) {
    if (/^#{1,6}\s+/.test(line) && current.length) {
      chunks.push(current.join('\n').trim());
      current = [line];
    } else {
      current.push(line);
    }
  }
  if (current.length) chunks.push(current.join('\n').trim());
  return chunks.filter(Boolean);
}

function headingFromChunk(chunk) {
  const match = String(chunk || '').match(/^#{1,6}\s+(.+)$/m);
  return match ? cleanInline(match[1], '') : '';
}

function bestMatchedChunkInfo(markdown, query) {
  const terms = String(query || '').toLowerCase()
    .split(/\s+/)
    .map(t => t.replace(/[^a-záàâãéèêíïóôõöúçñ0-9_-]/gi, ''))
    .filter(t => t.length >= 3 && !FTS_STOPWORDS.has(t));
  if (!terms.length) {
    const text = stripFrontmatter(markdown).replace(/\s+/g, ' ').trim().slice(0, 500);
    return { text, heading: headingFromChunk(stripFrontmatter(markdown)) };
  }

  let best = '';
  let bestScore = -1;
  for (const chunk of chunkMarkdown(markdown)) {
    const lower = chunk.toLowerCase();
    const score = terms.reduce((acc, term) => acc + (lower.includes(term) ? 1 : 0), 0);
    if (score > bestScore) {
      best = chunk;
      bestScore = score;
    }
  }
  const chunk = best || stripFrontmatter(markdown);
  return {
    text: chunk.replace(/\s+/g, ' ').trim().slice(0, 500),
    heading: headingFromChunk(chunk),
  };
}

function ftsRaw(ftsQuery, limit, rawQuery = '') {
  const safeLimit = clampInteger(limit, 10, 1, 50);
  const rows = sqliteRows(`SELECT p.path, p.title, p.category, p.summary, p.links, p.modified, p.permalink, p.content, substr(p.content, 1, 600) as snippet, f.rank FROM pages_fts f JOIN pages p ON p.path = f.path WHERE pages_fts MATCH '${escSql(ftsQuery)}' ORDER BY f.rank LIMIT ${safeLimit};`);
  return rows.map(r => {
    const match = bestMatchedChunkInfo(r.content || r.snippet || r.summary || '', rawQuery);
    return {
      item_type: 'note',
      path: r.path,
      title: r.title,
      category: r.category,
      permalink: r.permalink || '',
      source: r.permalink ? `memory://${r.permalink}` : r.path,
      heading: match.heading,
      summary: r.summary,
      snippet: (r.snippet || '').replace(/\n/g, ' ').trim().slice(0, 400),
      matched_text: match.text,
      links: r.links,
      modified: r.modified,
      score: Math.abs(r.rank || 0),
    };
  });
}

function mergeResults(...arrays) {
  const map = new Map();
  for (let i = 0; i < arrays.length; i++) {
    const decay = 1 - (i * 0.15); // later arrays get lower weight
    for (const r of arrays[i]) {
      if (map.has(r.path)) {
        const existing = map.get(r.path);
        existing.score = Math.max(existing.score, r.score * decay);
      } else {
        map.set(r.path, { ...r, score: r.score * decay });
      }
    }
  }
  return [...map.values()].sort((a, b) => b.score - a.score);
}

function indexSearch(query, limit = 15) {
  const esc = (s) => s.replace(/'/g, "''").replace(/"/g, '""');
  const safeLimit = clampInteger(limit, 15, 1, 50);
  const rawTokens = query.split(/\s+/).filter(t => t.length >= 2 && !FTS_STOPWORDS.has(t.toLowerCase()));
  if (rawTokens.length === 0) {
    const fallback = query.split(/\s+/).filter(t => t.length >= 2);
    if (fallback.length === 0) return [];
    const fts = fallback.map(t => `"${esc(t)}"*`).join(' OR ');
    return ftsRaw(fts, safeLimit, query);
  }

  const ftsTokens = rawTokens.map(t => `"${esc(t)}"*`);

  // Strategy 1: AND (high precision)
  let results = ftsRaw(ftsTokens.join(' AND '), safeLimit, query);

  // Strategy 2: OR (higher recall)
  if (results.length < 3 && rawTokens.length >= 2) {
    const orResults = ftsRaw(ftsTokens.join(' OR '), safeLimit, query);
    results = mergeResults(results, orResults);
  }

  // Strategy 3: Alias expansion
  if (results.length < 5) {
    const expanded = expandQueryLocal(rawTokens);
    const extraTokens = expanded
      .filter(t => !rawTokens.map(r => r.toLowerCase()).includes(t))
      .slice(0, 8)
      .map(t => `"${esc(t)}"*`);
    if (extraTokens.length > 0) {
      const expandedResults = ftsRaw([...ftsTokens, ...extraTokens].join(' OR '), safeLimit, query);
      results = mergeResults(results, expandedResults);
    }
  }

  return results.slice(0, safeLimit);
}

// ─── Hybrid Search (FTS + Semantic + LLM Expansion) ─────────────────────────
function hybridSearch(query, limit = 12) {
  // Phase 1: FTS multi-strategy
  let ftsResults = indexSearch(query, limit * 2);

  // Phase 2: Semantic search (local embeddings, ~1ms)
  const semanticResults = semanticSearch(query, limit);

  // Merge FTS + Semantic
  const semanticForMerge = semanticResults.map(r => {
    const meta = sqliteRows(`SELECT title, category, summary, links, modified, permalink, substr(content, 1, 400) as snippet FROM pages WHERE path = '${r.path.replace(/'/g, "''")}' LIMIT 1;`)[0] || {};
    return {
      item_type: 'note',
      path: r.path,
      title: meta.title || path.basename(r.path, '.md'),
      category: meta.category || '',
      permalink: meta.permalink || '',
      summary: meta.summary || '',
      snippet: meta.snippet || '',
      matched_text: meta.snippet || meta.summary || '',
      links: meta.links || 0,
      modified: meta.modified || '',
      score: r.similarity * 5, // scale to comparable range
    };
  });

  let merged = mergeResults(ftsResults, semanticForMerge);

  // Phase 3: LLM expansion (only if < 3 good results and query is complex)
  if (merged.length < 3 && query.split(/\s+/).length >= 2) {
    const expandedTerms = expandQueryLLM(query);
    if (expandedTerms.length > 0) {
      const esc = (s) => s.replace(/'/g, "''").replace(/"/g, '""');
      const expandedFts = expandedTerms.map(t => `"${esc(t)}"*`).join(' OR ');
      try {
        const expandedResults = ftsRaw(expandedFts, limit, query);
        merged = mergeResults(merged, expandedResults);
      } catch {}
    }
  }

  return merged.slice(0, limit);
}

// ─── Recency Boost ──────────────────────────────────────────────────────────
const TEMPORAL_WORDS = new Set(['última', 'ultimo', 'ontem', 'recente', 'hoje', 'semana', 'recent', 'yesterday', 'latest', 'last', 'nova', 'novo', 'agora']);

function applyRecencyBoost(results, query) {
  const tokens = query.toLowerCase().split(/\s+/);
  const hasTemporal = tokens.some(t => TEMPORAL_WORDS.has(t));
  if (!hasTemporal) return results;

  const now = Date.now();
  return results.map(r => {
    const mod = r.modified ? new Date(r.modified).getTime() : 0;
    const ageHours = (now - mod) / (1000 * 60 * 60);
    const boost = ageHours < 24 ? 2.5 : ageHours < 72 ? 1.8 : ageHours < 168 ? 1.3 : 1.0;
    return { ...r, score: r.score * boost };
  }).sort((a, b) => b.score - a.score);
}

function safeJsonArray(value) {
  try {
    const parsed = JSON.parse(value || '[]');
    return Array.isArray(parsed) ? parsed.map(v => String(v).toLowerCase()) : [];
  } catch {
    return [];
  }
}

function rowNamespace(rowPath) {
  const parts = String(rowPath || '').split('/').filter(Boolean);
  if (!parts.length) return '';
  if (LEGACY_NAMESPACES.has(parts[0])) return parts[0];
  if (parts[0] === ARCHIVE_ROOT && parts[1] === 'namespaces' && LEGACY_NAMESPACES.has(parts[2])) {
    return parts[2];
  }
  return '';
}

function rowAgentFromMetadata(metadata) {
  if (!metadata) return '';
  let meta = metadata;
  if (typeof metadata === 'string') {
    try { meta = JSON.parse(metadata); } catch { return ''; }
  }
  if (!meta || typeof meta !== 'object') return '';
  return cleanInline(meta.agent || '', '');
}

function rowAgent(row) {
  const fromMeta = rowAgentFromMetadata(row.metadata || row.agent);
  if (fromMeta) return fromMeta;
  const ns = rowNamespace(row.path);
  if (ns === 'Codex' || ns === 'Nitro' || ns === 'shared') return ns;
  return '';
}

/** Map deprecated namespace filter → agent (legacy compat for one release). */
function resolveAgentFilter(args) {
  const agent = cleanInline(args.agent || '', '');
  if (agent) return agent;
  const namespace = cleanInline(args.namespace || '', '');
  if (namespace) return namespace;
  return '';
}

function parseDateFilter(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date : null;
}

function textMatchesQuery(query, ...fields) {
  const normalized = String(query || '').trim().toLowerCase();
  if (!normalized) return true;
  const haystack = fields.filter(Boolean).join(' ').toLowerCase();
  const terms = normalized.split(/\s+/).filter(t => t.length >= 2 && !FTS_STOPWORDS.has(t));
  return (terms.length ? terms : [normalized]).every(term => haystack.includes(term));
}

function commonRowFilters(row, args) {
  const agentFilter = resolveAgentFilter(args);
  if (agentFilter && rowAgent(row) !== agentFilter) return false;

  const after = parseDateFilter(args.after_date);
  if (after && new Date(row.modified || 0) < after) return false;

  const requiredTags = normalizeStringArray(args.tags).map(t => t.toLowerCase());
  if (requiredTags.length) {
    const rowTags = safeJsonArray(row.tags);
    if (!requiredTags.every(tag => rowTags.includes(tag))) return false;
  }

  return true;
}

function searchObservationRows(query, args, limit) {
  const safeLimit = clampInteger(limit, 10, 1, 50);
  const rows = sqliteRows(`
    SELECT o.*, p.permalink as note_permalink, p.category as note_category, p.metadata, p.tags as page_tags
    FROM observations o
    JOIN pages p ON p.path = o.path
    ORDER BY o.modified DESC
    LIMIT 500;
  `);
  const category = cleanInline(args.category || '', '').toLowerCase();
  const filtered = rows.filter(row => {
    if (category && String(row.category || '').toLowerCase() !== category) return false;
    if (!commonRowFilters(row, args)) return false;
    return textMatchesQuery(query, row.content, row.category, row.context, row.title);
  });
  return filtered.slice(0, safeLimit).map((row, index) => ({
    item_type: 'observation',
    path: row.path,
    title: row.title,
    category: row.category,
    permalink: row.permalink || row.note_permalink || '',
    matched_text: row.content,
    summary: row.content,
    snippet: row.content,
    context: row.context || '',
    modified: row.modified,
    score: safeLimit - index,
  }));
}

function searchRelationRows(query, args, limit) {
  const safeLimit = clampInteger(limit, 10, 1, 50);
  const rows = sqliteRows(`
    SELECT r.*, p.permalink as note_permalink, p.category as note_category, p.tags, p.metadata
    FROM relations r
    JOIN pages p ON p.path = r.path
    ORDER BY r.modified DESC
    LIMIT 500;
  `);
  const relationType = cleanInline(args.relation_type || '', '').toLowerCase();
  const filtered = rows.filter(row => {
    if (relationType && String(row.relation_type || '').toLowerCase() !== relationType) return false;
    if (!commonRowFilters(row, args)) return false;
    return textMatchesQuery(query, row.target, row.relation_type, row.context, row.title);
  });
  return filtered.slice(0, safeLimit).map((row, index) => ({
    item_type: 'relation',
    path: row.path,
    title: row.title,
    category: row.relation_type,
    permalink: row.permalink || row.note_permalink || '',
    matched_text: `${row.relation_type} [[${row.target}]]${row.context ? ` (${row.context})` : ''}`,
    summary: `${row.relation_type} -> ${row.target}`,
    snippet: `${row.relation_type} -> ${row.target}`,
    relation_type: row.relation_type,
    target: row.target,
    context: row.context || '',
    modified: row.modified,
    score: safeLimit - index,
  }));
}

function filterNoteResults(results, args) {
  const agentFilter = resolveAgentFilter(args);
  const category = cleanInline(args.category || '', '');
  const after = parseDateFilter(args.after_date);
  return results.filter(row => {
    if (agentFilter) {
      // Enrich from index when search result lacks metadata
      let agent = rowAgent(row);
      if (!agent && row.path) {
        const page = sqliteRows(`SELECT path, metadata FROM pages WHERE path = '${escSql(row.path)}' LIMIT 1;`)[0];
        if (page) agent = rowAgent(page);
      }
      if (agent !== agentFilter) return false;
    }
    if (category && String(row.category || '').toLowerCase() !== category.toLowerCase()) return false;
    if (after && new Date(row.modified || 0) < after) return false;
    return true;
  });
}

function formatSearchResult(r, index, includeSnippets = true) {
  const itemType = r.item_type || 'note';
  const sourceValue = r.source || (r.permalink ? `memory://${r.permalink}` : r.path);
  const source = sourceValue ? `\n   source: \`${sourceValue}\`` : '';
  const permalink = r.permalink ? `\n   permalink: \`${r.permalink}\`` : '';
  const heading = r.heading ? `\n   heading: \`${r.heading}\`` : '';
  const matched = r.matched_text || r.summary || r.snippet || '';
  const snippet = includeSnippets && matched ? `\n   ${matched.slice(0, 500)}` : '';
  return `${index + 1}. **${r.title}** [${itemType}:${r.category || ''}] — \`${r.path}\`${snippet}${source}${permalink}${heading}\n   _modified: ${r.modified || '?'} | score: ${r.score?.toFixed?.(3) || r.score || '-'}_`;
}

// ─── Hot Context ────────────────────────────────────────────────────────────
function getHotContext() {
  const hotPath = path.join(VAULT_DIR, 'hot.md');
  try {
    const safe = safeVaultRealPath(hotPath);
    if (!safe) return '';
    return fs.readFileSync(safe, 'utf8').slice(0, 800);
  } catch { return ''; }
}

function safeVaultRealPath(candidate) {
  try {
    const realVault = fs.realpathSync(VAULT_DIR);
    const realCandidate = fs.realpathSync(candidate);
    return isInsideDir(realVault, realCandidate) ? realCandidate : null;
  } catch {
    return null;
  }
}

function safeVaultWritePath(candidate) {
  try {
    if (!isInsideDir(VAULT_DIR, candidate)) return null;
    const realVault = fs.realpathSync(VAULT_DIR);
    const parent = path.dirname(candidate);
    const realParent = fs.realpathSync(parent);
    if (!isInsideDir(realVault, realParent)) return null;
    try {
      const lst = fs.lstatSync(candidate);
      if (lst.isSymbolicLink()) return null;
      const realCandidate = fs.realpathSync(candidate);
      if (!isInsideDir(realVault, realCandidate)) return null;
    } catch (error) {
      if (error.code !== 'ENOENT') return null;
    }
    return candidate;
  } catch {
    return null;
  }
}

function resolveVaultCandidate(baseDir, requestedPath) {
  const resolved = path.resolve(baseDir, requestedPath);
  return isInsideDir(VAULT_DIR, resolved) ? resolved : null;
}

function pageRowsWhere(whereSql, limit = 10) {
  const safeLimit = clampInteger(limit, 10, 1, 50);
  return sqliteRows(`SELECT path, title, category, permalink, note_type, tags, modified FROM pages WHERE ${whereSql} LIMIT ${safeLimit};`);
}

function resolveMemoryUrl(memoryUrl) {
  const raw = String(memoryUrl || '').trim();
  const value = raw.replace(/^memory:\/\//i, '').trim();
  if (!value || path.isAbsolute(value) || value.split(/[\\/]+/).includes('..')) {
    return { error: 'Path fora do vault.' };
  }

  if (value.includes('*')) {
    const like = escSql(value.replace(/\*/g, '%'));
    const rows = pageRowsWhere(`permalink LIKE '${like}' OR path LIKE '${like}' OR title LIKE '${like}'`, 25);
    if (rows.length > 1) return { error: `memory:// ambíguo: ${rows.map(r => r.path).join(', ')}` };
    if (rows.length === 1) return { ...resolveVaultReadPath(rows[0].path), relPath: rows[0].path };
    return { filePath: null };
  }

  // Prefer index match first so permalink/path casing matches the SQLite row
  // (macOS APFS is case-insensitive and realpath can preserve the requested case).
  const safe = escSql(value);
  const indexed = pageRowsWhere(`permalink = '${safe}' OR path = '${safe}' OR title = '${safe}' COLLATE NOCASE`, 2);
  if (indexed.length > 1) return { error: `memory:// ambíguo: ${indexed.map(r => r.path).join(', ')}` };
  if (indexed.length === 1) return { ...resolveVaultReadPath(indexed[0].path), relPath: indexed[0].path };

  const directCandidates = [
    resolveVaultCandidate(VAULT_DIR, value),
    resolveVaultCandidate(VAULT_DIR, `${value}.md`),
  ].filter(Boolean);
  for (const candidate of directCandidates) {
    const safePath = safeVaultRealPath(candidate);
    if (safePath && fs.statSync(safePath).isFile()) {
      const relPath = relVaultRealPath(safePath);
      const byPath = pageRowsWhere(`path = '${escSql(relPath)}' COLLATE NOCASE`, 1);
      return { filePath: safePath, relPath: byPath[0]?.path || relPath };
    }
  }

  return { filePath: null };
}

function resolveVaultReadPath(requestedPath) {
  const p = String(requestedPath || '').trim();
  if (p.toLowerCase().startsWith('memory://')) return resolveMemoryUrl(p);
  if (!p || path.isAbsolute(p)) return { error: 'Path fora do vault.' };
  if (p.split(/[\\/]+/).includes('..')) return { error: 'Path fora do vault.' };

  const candidates = [
    resolveVaultCandidate(VAULT_ROOT, p),
    resolveVaultCandidate(VAULT_DIR, p),
    resolveVaultCandidate(VAULT_DIR, `${p}.md`),
  ].filter(Boolean);

  for (const candidate of [...new Set(candidates)]) {
    try {
      const safe = safeVaultRealPath(candidate);
      if (safe && fs.statSync(safe).isFile()) {
        return { filePath: safe, relPath: relVaultRealPath(safe) };
      }
    } catch {}
  }

  return { filePath: null };
}

// ─── Tool Handlers ──────────────────────────────────────────────────────────

function handleVaultRecall(args) {
  refreshVaultIndex();
  const query = args.query || '';
  const maxTokens = clampInteger(args.max_tokens, 2000, 200, 12000);
  const sections = [];
  let usedTokens = 0;

  // 1. Hot context (always include)
  const hot = getHotContext();
  if (hot) {
    const cost = Math.ceil(hot.length / 4);
    sections.push({ title: '🔥 HOT CONTEXT', content: hot });
    usedTokens += cost;
  }

  // 2. FTS matches
  if (query) {
    const ftsResults = indexSearch(query, 8);
    for (const r of ftsResults) {
      if (usedTokens >= maxTokens) break;
      const content = r.summary || r.snippet || '';
      const cost = Math.ceil(content.length / 4);
      if (usedTokens + cost > maxTokens) break;
      sections.push({ title: r.title, path: r.path, category: r.category, content, score: r.score });
      usedTokens += cost;
    }
  }

  // 3. Semantic matches (local cosine, ~1ms)
  if (query && LOCAL_EMBEDDING_STORE.size > 0) {
    const queryVec = createLocalEmbedding(query);
    const scored = [];
    for (const [pagePath, vector] of LOCAL_EMBEDDING_STORE) {
      const sim = cosineSim(queryVec, vector);
      if (sim > 0.2) scored.push({ path: pagePath, similarity: sim });
    }
    scored.sort((a, b) => b.similarity - a.similarity);

    const seen = new Set(sections.map(s => s.path));
    for (const match of scored.slice(0, 6)) {
      if (usedTokens >= maxTokens) break;
      if (seen.has(match.path)) continue;
      seen.add(match.path);

      const meta = sqliteRows(`SELECT title, category, summary FROM pages WHERE path = '${match.path.replace(/'/g, "''")}' LIMIT 1;`)[0];
      const content = meta?.summary || '';
      const cost = Math.ceil(content.length / 4);
      if (usedTokens + cost > maxTokens) break;
      sections.push({ title: meta?.title || path.basename(match.path, '.md'), path: match.path, category: meta?.category || '', content, score: match.similarity });
      usedTokens += cost;
    }
  }

  if (sections.length <= 1 && !hot) {
    return text(`[Alexandria] Nenhuma memória relevante para "${query}".`);
  }

  const body = sections.map(s => {
    if (s.title === '🔥 HOT CONTEXT') return `## 🔥 Hot Context\n${s.content}`;
    return `## ${s.title}\n_${s.category || ''} | ${s.path || ''} | score: ${s.score?.toFixed?.(2) || '-'}_\n${s.content}`;
  }).join('\n\n');

  return text(`[Alexandria Recall] ${sections.length} seções | ~${usedTokens} tokens\n\n${body}`);
}

function handleVaultRead(args) {
  refreshVaultIndex();
  const p = args.path || '';
  if (!p) return text('Path obrigatório.');

  const resolved = resolveVaultReadPath(p);
  if (resolved.error) return text(resolved.error);
  if (resolved.filePath) {
    return text(fs.readFileSync(resolved.filePath, 'utf8'));
  }

  // Fuzzy match by filename
  const base = path.basename(p, '.md');
  const found = findFileRecursive(VAULT_DIR, base + '.md') || findFileRecursive(VAULT_DIR, base);
  if (found) {
    const safe = safeVaultRealPath(found);
    if (safe) return text(fs.readFileSync(safe, 'utf8'));
  }

  return text(`Nota não encontrada: ${p}`);
}

function handleVaultList(args) {
  refreshVaultIndex();
  const category = args.category || '';
  const limit = clampInteger(args.limit, 30, 1, 100);
  const sort = args.sort || 'recent';

  let sql = 'SELECT path, title, category, summary, modified, links FROM pages';
  if (category) sql += ` WHERE category = '${escSql(category)}'`;

  const orderMap = { recent: 'modified DESC', name: 'title ASC', links: 'links DESC' };
  sql += ` ORDER BY ${orderMap[sort] || 'modified DESC'} LIMIT ${limit};`;

  const rows = sqliteRows(sql);
  if (!rows.length) return text('Vault vazio ou categoria inválida.');

  const lines = rows.map(r => `- **${r.title}** [${r.category}] — \`${r.path}\` (${r.modified?.slice(0, 10) || '?'}) [${r.links || 0} links]`);
  return text(`${rows.length} notas:\n\n${lines.join('\n')}`);
}

function pageByPath(relPath) {
  return sqliteRows(`SELECT path, title, category, content, summary, modified, permalink FROM pages WHERE path = '${escSql(relPath)}' LIMIT 1;`)[0] || null;
}

function pageByTitleOrPermalink(value) {
  const safe = escSql(value);
  return sqliteRows(`SELECT path, title, category, content, summary, modified, permalink FROM pages WHERE title = '${safe}' COLLATE NOCASE OR permalink = '${safe}' OR path = '${safe}' LIMIT 1;`)[0] || null;
}

function pagesMatchingTargets(targets) {
  const unique = [...new Set(targets.map((value) => cleanInline(value || '', '')).filter(Boolean))];
  if (!unique.length) return [];
  const inList = unique.map((value) => `'${escSql(value)}'`).join(', ');
  return sqliteRows(`
    SELECT path, title, category, content, summary, modified, permalink
    FROM pages
    WHERE title COLLATE NOCASE IN (${inList})
       OR permalink IN (${inList})
       OR path IN (${inList})
  `);
}

function matchPageForTarget(pages, target) {
  const raw = cleanInline(target || '', '');
  if (!raw) return null;
  const lower = raw.toLowerCase();
  return pages.find((candidate) => (
    String(candidate.title || '').toLowerCase() === lower
    || String(candidate.permalink || '') === raw
    || String(candidate.path || '') === raw
  )) || pages.find((candidate) => relationTargetMatchesPage(raw, candidate)) || null;
}

function pagesByPathList(paths) {
  const unique = [...new Set(paths.map((value) => cleanInline(value || '', '')).filter(Boolean))];
  if (!unique.length) return new Map();
  const inList = unique.map((value) => `'${escSql(value)}'`).join(', ');
  const rows = sqliteRows(`
    SELECT path, title, category, content, summary, modified, permalink
    FROM pages
    WHERE path IN (${inList})
  `);
  return new Map(rows.map((row) => [row.path, row]));
}

function graphIdentityKeys(page) {
  const basename = path.basename(page.path || '', '.md');
  return [...new Set(
    [page.title, page.path, String(page.path || '').replace(/\.md$/i, ''), basename, page.permalink]
      .filter(Boolean)
      .map((value) => String(value)),
  )];
}

function observationsForPath(relPath) {
  return sqliteRows(`SELECT category, content, tags, context, permalink FROM observations WHERE path = '${escSql(relPath)}' ORDER BY category, content LIMIT 50;`);
}

function relationsForPath(relPath) {
  return sqliteRows(`SELECT relation_type, target, context, permalink FROM relations WHERE path = '${escSql(relPath)}' ORDER BY relation_type, target LIMIT 50;`);
}

function relPathFromSource(source) {
  const resolved = resolveVaultReadPath(source);
  if (resolved.error || !resolved.filePath) return null;
  return resolved.relPath || relVaultRealPath(resolved.filePath);
}

function formatContextSection(page, includeObservations = true) {
  const lines = [
    `## ${page.title} (\`${page.path}\`)`,
    `_${page.category || ''}${page.permalink ? ` | memory://${page.permalink}` : ''} | modified: ${page.modified || '?'}_`,
    '',
  ];
  if (includeObservations) {
    const observations = observationsForPath(page.path);
    if (observations.length) {
      lines.push('### Observations');
      for (const obs of observations) {
        lines.push(`- [${obs.category}] ${obs.content}${obs.context ? ` (${obs.context})` : ''}`);
      }
      lines.push('');
    }
  }
  const content = stripFrontmatter(page.content || '').trim();
  if (content) lines.push(content.slice(0, 2000));
  return lines.join('\n');
}

function buildGraphContextFromSource(args) {
  const source = args.source || args.query || '';
  const relPath = relPathFromSource(source);
  if (!relPath) return text(`Fonte não encontrada: ${source}`);

  const depth = clampInteger(args.depth, 1, 0, 3);
  const maxRelated = clampInteger(args.max_related, 10, 0, 30);
  const maxTokens = clampInteger(args.max_tokens, 3000, 200, 20000);
  const includeObservations = args.include_observations !== false;
  const sections = [];
  const seen = new Set();
  const queue = [{ path: relPath, depth: 0 }];

  while (queue.length && sections.length <= maxRelated + 1) {
    const current = queue.shift();
    if (seen.has(current.path)) continue;
    seen.add(current.path);
    const page = pageByPath(current.path);
    if (!page) continue;

    sections.push(formatContextSection(page, includeObservations));
    if (current.depth >= depth) continue;

    for (const relation of relationsForPath(current.path)) {
      const targetPage = pageByTitleOrPermalink(relation.target);
      if (targetPage && !seen.has(targetPage.path)) {
        queue.push({ path: targetPage.path, depth: current.depth + 1 });
      }
    }
  }

  let tokenBudget = maxTokens;
  const trimmed = [];
  for (const section of sections) {
    const cost = Math.ceil(section.length / 4);
    if (tokenBudget - cost < 0) {
      const available = Math.max(0, tokenBudget * 4);
      if (available > 0) trimmed.push(section.slice(0, available));
      break;
    }
    trimmed.push(section);
    tokenBudget -= cost;
  }

  return text(`# Alexandria Graph Context\nSource: ${source} | Sections: ${trimmed.length} | depth=${depth}\n\n${trimmed.join('\n\n---\n\n')}`);
}

function handleVaultContext(args) {
  refreshVaultIndex();
  if (args.source) return buildGraphContextFromSource(args);

  const query = args.query || '';
  const maxTokens = clampInteger(args.max_tokens, 3000, 200, 20000);
  const limit = clampInteger(args.limit, 10, 1, 50);

  if (!query.trim()) return text('Query obrigatória.');

  let results = hybridSearch(query, limit * 2);
  results = applyRecencyBoost(results, query);
  results = results.slice(0, limit);

  if (results.length === 0) return text(`Sem contexto relevante para "${query}".`);

  // Build context package with full content and token budget
  let tokenBudget = maxTokens;
  const sections = [];

  // Always include hot.md as preamble
  const hot = getHotContext();
  if (hot) {
    const cost = Math.ceil(hot.length / 4);
    if (cost < tokenBudget) {
      sections.push(`## 🔥 Hot Context\n${hot}`);
      tokenBudget -= cost;
    }
  }

  for (const r of results) {
    if (tokenBudget <= 100) break;

    let content = '';
    const resolved = resolveVaultReadPath(r.path);
    if (resolved.filePath) {
      try { content = fs.readFileSync(resolved.filePath, 'utf8'); } catch {}
    }
    if (!content) content = r.snippet || r.summary || '';

    const available = Math.min(content.length, tokenBudget * 4);
    const chunk = content.slice(0, available);
    const cost = Math.ceil(chunk.length / 4);

    sections.push(`## ${r.title} (\`${r.path}\`)\n_${r.category} | score: ${r.score?.toFixed(3)} | modified: ${r.modified || '?'}_\n\n${chunk}`);
    tokenBudget -= cost;
  }

  return text(`# Alexandria Context\nQuery: "${query}" | Sections: ${sections.length} | Budget: ~${maxTokens - tokenBudget}/${maxTokens} tokens\n\n${sections.join('\n\n---\n\n')}`);
}

const CAPTURE_KINDS = new Set(['fact', 'decision', 'procedure', 'gotcha']);

function normalizeCaptureKind(value) {
  const kind = cleanInline(value || '', '').toLowerCase();
  return CAPTURE_KINDS.has(kind) ? kind : '';
}

function extraFrontmatterLines(args) {
  const status = cleanInline(args.status || '', '');
  const kind = normalizeCaptureKind(args.kind);
  const lines = [];
  if (status) lines.push(`status: ${status}`);
  if (kind) lines.push(`kind: ${kind}`);
  return lines.length ? lines.join('\n') : null;
}

function handleVaultWrite(args) {
  const { title, content, category } = args;
  if (!title || !content) return text('title e content são obrigatórios.');

  const cat = normalizeCategory(category);
  if (!cat) return text(`Categoria inválida. Use uma destas: ${[...WRITE_CATEGORIES].join(', ')}.`);

  const safeTitle = cleanInline(title);
  const body = String(content);
  const safeTags = normalizeStringArray(args.tags);
  const safeLinks = normalizeStringArray(args.links);
  const agent = getWriteAgent(args);
  const dir = path.join(VAULT_DIR, cat);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const slug = slugify(safeTitle);
  const filePath = path.join(dir, `${slug}.md`);
  if (!safeVaultWritePath(filePath)) return text('Path fora do vault ou symlink inseguro.');
  if (args.overwrite === false && fs.existsSync(filePath)) {
    return text(`Nota já existe: ${vaultRelativePath(cat, `${slug}.md`)}. Use overwrite: true para substituir.`);
  }

  const now = new Date().toISOString();
  const source = cleanInline(args.source || '', '');

  // Build frontmatter
  const fm = [
    '---',
    `title: "${safeTitle.replace(/"/g, '\\"')}"`,
    `category: ${cat}`,
    agent ? `agent: ${agent}` : null,
    source ? `source: ${source}` : null,
    `created: ${now}`,
    `modified: ${now}`,
    safeTags.length ? `tags: [${safeTags.map(t => `"${t.replace(/"/g, '\\"')}"`).join(', ')}]` : null,
    safeLinks.length ? `links: [${safeLinks.map(l => `"${l.replace(/"/g, '\\"')}"`).join(', ')}]` : null,
    extraFrontmatterLines(args),
    '---',
  ].filter(Boolean).join('\n');

  // Add wikilinks if provided
  const wikilinks = safeLinks.length ? `\n\n## Relacionado\n${safeLinks.map(l => `[[${l}]]`).join(' · ')}` : '';

  const fullContent = `${fm}\n\n# ${safeTitle}\n\n${body}${wikilinks}\n`;
  fs.writeFileSync(filePath, fullContent);

  // Update SQLite index
  const relPath = vaultRelativePath(cat, `${slug}.md`);
  const summary = body.slice(0, 300).replace(/\n/g, ' ');
  const parsed = parseSemanticMarkdown(fullContent, relPath, filePath);
  applyEffectivePermalink(parsed, relPath);
  upsertPageIndex({
    relPath,
    title: safeTitle,
    category: cat,
    content: fullContent,
    summary,
    modified: now,
    links: safeLinks.length,
    permalink: parsed.permalink,
    noteType: parsed.noteType,
    tags: parsed.tags,
    metadata: parsed.metadata,
    size: Buffer.byteLength(fullContent, 'utf8'),
  });
  indexStructuredItems({ relPath, parsed, modified: now });

  // Update local embedding
  LOCAL_EMBEDDING_STORE.set(relPath, createLocalEmbedding([safeTitle, cat, summary].join(' ')));

  return text(`✓ Nota salva: ${relPath}\nPath absoluto: ${filePath}`);
}

function handleVaultAutoSave(args) {
  const { title, summary, decisions } = args;
  if (!title || !summary) return text('title e summary são obrigatórios.');

  const safeTitle = cleanInline(title);
  const safeSummary = String(summary);
  const safeTags = normalizeStringArray(args.tags);
  const safeLinks = normalizeStringArray(args.links);
  const agent = getWriteAgent(args);
  const now = new Date();
  const dateStr = now.toISOString().slice(0, 10);
  const slug = `${dateStr}-${slugify(safeTitle).slice(0, 50)}`;

  const dir = path.join(VAULT_DIR, 'sessions');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const filePath = path.join(dir, `${slug}.md`);
  if (!safeVaultWritePath(filePath)) return text('Path fora do vault ou symlink inseguro.');

  const content = [
    '---',
    `title: "${safeTitle.replace(/"/g, '\\"')}"`,
    `category: sessions`,
    agent ? `agent: ${agent}` : null,
    `created: ${now.toISOString()}`,
    `modified: ${now.toISOString()}`,
    safeTags.length ? `tags: [${safeTags.map(t => `"${t.replace(/"/g, '\\"')}"`).join(', ')}]` : null,
    '---',
    '',
    `# ${safeTitle}`,
    `> Sessão ${dateStr} — auto-save via Alexandria`,
    '',
    '## Resumo',
    safeSummary,
    '',
    decisions ? `## Decisões\n${decisions}\n` : null,
    safeLinks.length ? `## Relacionado\n${safeLinks.map(l => `[[${l}]]`).join(' · ')}` : null,
    '',
  ].filter(x => x !== null).join('\n');

  fs.writeFileSync(filePath, content);

  // Update index
  const relPath = vaultRelativePath('sessions', `${slug}.md`);
  const parsed = parseSemanticMarkdown(content, relPath, filePath);
  applyEffectivePermalink(parsed, relPath);
  upsertPageIndex({
    relPath,
    title: safeTitle,
    category: 'sessions',
    content,
    summary: safeSummary.slice(0, 300),
    modified: now.toISOString(),
    links: safeLinks.length,
    permalink: parsed.permalink,
    noteType: parsed.noteType,
    tags: parsed.tags,
    metadata: parsed.metadata,
    size: Buffer.byteLength(content, 'utf8'),
  });
  indexStructuredItems({ relPath, parsed, modified: now.toISOString() });

  // Update hot.md with latest session
  updateHotContext(safeTitle, dateStr, safeLinks);

  // Update local embedding
  LOCAL_EMBEDDING_STORE.set(relPath, createLocalEmbedding([safeTitle, 'sessions', safeSummary].join(' ')));

  return text(`✓ Sessão salva: ${relPath}\nTítulo: ${safeTitle}\nHot.md atualizado.`);
}

function updateHotContext(title, dateStr, links) {
  const hotPath = path.join(VAULT_DIR, 'hot.md');
  if (!safeVaultWritePath(hotPath)) return;
  try {
    let hot = fs.existsSync(hotPath) ? fs.readFileSync(hotPath, 'utf8') : defaultHotContext();
    if (!hot.includes('> Last updated:')) {
      hot = `${hot.trim()}\n\n> Last updated: never\n`;
    }
    if (!hot.includes('## Recent Activity')) {
      hot = `${hot.trim()}\n\n## Recent Activity\n`;
    }

    // Update "Last updated" line
    hot = hot.replace(/> Last updated:.*/, `> Last updated: ${dateStr}`);

    // Add to Recent Activity (at the top of the list)
    const activityLine = `- **[${dateStr}]** [[${slugify(title)}]] — ${links?.length ? links.map(l => `[[${l}]]`).join(', ') : 'sessão codex'}`;
    hot = hot.replace(
      /## Recent Activity\n/,
      `## Recent Activity\n${activityLine}\n`
    );

    fs.writeFileSync(hotPath, hot);
  } catch {}
}

function handleVaultStats() {
  refreshVaultIndex();
  const pages = sqliteRows('SELECT COUNT(*) as total FROM pages;')[0]?.total || 0;
  const embeddings = EMBEDDING_STORE.size;
  const localEmbs = LOCAL_EMBEDDING_STORE.size;
  const categories = sqliteRows("SELECT category, COUNT(*) as cnt FROM pages GROUP BY category ORDER BY cnt DESC;");
  const recentPages = sqliteRows("SELECT title, category, modified FROM pages ORDER BY modified DESC LIMIT 5;");
  const indexFailures = [...INDEX_FAILURES.entries()].slice(0, 5);

  const hot = getHotContext();
  const hotLines = hot.split('\n').filter(l => l.startsWith('- ')).length;

  const body = [
    `## Vault Stats`,
    `- Total pages: ${pages}`,
    `- API embeddings: ${embeddings}`,
    `- Local embeddings: ${localEmbs}`,
    `- Expansion cache: ${EXPANSION_CACHE.size} entries`,
    `- Index failures: ${INDEX_FAILURES.size}`,
    `- Hot context: ${hotLines} items`,
    '',
    '## Categories',
    ...categories.map(c => `- ${c.category}: ${c.cnt}`),
    '',
    '## Recent',
    ...recentPages.map(p => `- ${p.title} [${p.category}] — ${p.modified?.slice(0, 10)}`),
    ...(indexFailures.length ? ['', '## Index Failures', ...indexFailures.map(([relPath, failure]) => `- ${relPath}: ${failure.message} (${failure.ts})`)] : []),
  ].join('\n');

  return text(body);
}

function handleVaultRecentActivity(args) {
  refreshVaultIndex();
  const pageSize = clampInteger(args.page_size || args.limit, 10, 1, 50);
  const page = clampInteger(args.page, 1, 1, 100000);
  const offset = (page - 1) * pageSize;
  const total = sqliteRows("SELECT COUNT(*) as total FROM pages WHERE path != 'hot.md';")[0]?.total || 0;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const rows = sqliteRows(`
    SELECT path, title, category, modified, permalink
    FROM pages
    WHERE path != 'hot.md'
    ORDER BY modified DESC, title ASC
    LIMIT ${pageSize} OFFSET ${offset};
  `);

  if (!rows.length) return text(`Nenhuma atividade recente. page ${page}/${totalPages}`);

  const lines = rows.map(row =>
    `- **${row.title}** [${row.category}] — \`${row.path}\` (${row.modified || '?'})${row.permalink ? ` memory://${row.permalink}` : ''}`
  );
  return text(`# Recent Activity — page ${page}/${totalPages}\n\n${lines.join('\n')}`);
}

// ─── Helpers ────────────────────────────────────────────────────────────────
function text(t) { return { content: [{ type: 'text', text: t }] }; }

function findFileRecursive(dir, name) {
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isFile() && e.name.toLowerCase() === name.toLowerCase()) return full;
      if (e.isDirectory()) {
        const found = findFileRecursive(full, name);
        if (found) return found;
      }
    }
  } catch {}
  return null;
}

function log(msg) { process.stderr.write(`[alexandria-codex] ${msg}\n`); }

// ─── MCP Protocol ───────────────────────────────────────────────────────────
const TOOLS = [
  {
    name: 'vault_recall',
    description: 'Ultra-fast recall (<100ms, zero API calls). Returns: hot context (active projects/sessions) + FTS matches + semantic matches from in-memory embeddings. Use as FIRST tool call of any session or question. If empty, the vault has no info on the topic.',
    annotations: { readOnlyHint: true, openWorldHint: false },
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Keywords about the subject (2-5 words)' },
        max_tokens: { type: 'number', description: 'Max token budget (default: 2000)' },
      },
      required: ['query'],
    },
  },
  {
    name: 'vault_search',
    description: 'Smart search with query expansion and structured filters. Can return notes, observations, or relations with citation fields: source/path/permalink/heading/matched_text.',
    annotations: { readOnlyHint: true, openWorldHint: false },
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Natural language search (PT-BR or EN)' },
        limit: { type: 'number', description: 'Max results (default: 10)' },
        entity_type: { type: 'string', enum: ['note', 'observation', 'relation', 'all'], description: 'Return notes (default), observations, relations, or all item types' },
        category: { type: 'string', description: 'Filter by note category or observation category' },
        relation_type: { type: 'string', description: 'Filter relation results by relation type' },
        namespace: { type: 'string', description: 'Deprecated: maps to agent filter (legacy Codex/Nitro/shared). Prefer agent.' },
        agent: { type: 'string', description: 'Filter by frontmatter agent (Codex, Nitro, Cursor, …); legacy path namespace also matches' },
        tags: { type: 'array', items: { type: 'string' }, description: 'Require all tags' },
        after_date: { type: 'string', description: 'Only results modified after this ISO date' },
        search_type: { type: 'string', enum: ['fts', 'local_semantic', 'hybrid'], description: 'Search mode for note results (default: hybrid)' },
        include_snippets: { type: 'boolean', description: 'Include matched_text snippets in formatted results (default true)' },
      },
      required: ['query'],
    },
  },
  {
    name: 'vault_read',
    description: 'Read full content of a vault note. Use after vault_search to get details.',
    annotations: { readOnlyHint: true, openWorldHint: false },
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Relative path (e.g. wiki/concepts/React.md or just "React")' },
      },
      required: ['path'],
    },
  },
  {
    name: 'vault_context',
    description: 'Build a rich context package for a task/question. Supports search query or source memory:// URL with graph traversal over relations/wikilinks.',
    annotations: { readOnlyHint: true, openWorldHint: false },
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'The task or question to get context for' },
        source: { type: 'string', description: 'Optional source note path, title, permalink, or memory:// URL for graph context' },
        entity_type: { type: 'string', enum: ['note', 'observation', 'relation', 'all'], description: 'Preferred context entity type for future structured context filtering' },
        depth: { type: 'number', description: 'Relation traversal depth (default 1, max 3)' },
        max_related: { type: 'number', description: 'Max related notes for graph context (default 10)' },
        include_observations: { type: 'boolean', description: 'Include parsed observations (default true)' },
        max_tokens: { type: 'number', description: 'Token budget (default: 3000)' },
        limit: { type: 'number', description: 'Max sections (default: 10)' },
      },
    },
  },
  {
    name: 'vault_write',
    description: 'Write a new note to the vault. Creates markdown file with frontmatter, updates FTS index and embeddings. Use to persist knowledge, document decisions, or save patterns.',
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Note title' },
        content: { type: 'string', description: 'Note body (markdown)' },
        category: { type: 'string', enum: ['concepts', 'entities', 'decisions', 'sessions', 'projects', 'patterns', 'tools', 'postmortems', 'research', 'plans'], description: 'Category (default: concepts)' },
        agent: { type: 'string', description: 'Provenance agent (Codex, Nitro, Cursor). ALEXANDRIA_NAMESPACE also sets agent, not path.' },
        source: { type: 'string', description: 'Provenance source (cursor-agent, codex, nitro, …)' },
        tags: { type: 'array', items: { type: 'string' }, description: 'Tags for retrieval' },
        links: { type: 'array', items: { type: 'string' }, description: 'Related note titles for wikilinks' },
        overwrite: { type: 'boolean', description: 'When false, refuse to overwrite an existing note slug' },
      },
      required: ['title', 'content'],
    },
  },
  {
    name: 'vault_auto_save',
    description: 'Auto-save a session summary. Creates dated note in sessions/, updates hot.md and FTS index. Use at end of productive sessions (built something, made decision, solved bug, learned something new).',
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Short session title' },
        summary: { type: 'string', description: 'Summary in 3-5 bullets of what was done/decided/learned' },
        decisions: { type: 'string', description: 'Key decisions made (optional)' },
        agent: { type: 'string', description: 'Provenance agent (optional; ALEXANDRIA_NAMESPACE also sets agent)' },
        tags: { type: 'array', items: { type: 'string' }, description: 'Tags for retrieval' },
        links: { type: 'array', items: { type: 'string' }, description: 'Related note titles for wikilinks' },
      },
      required: ['title', 'summary'],
    },
  },
  {
    name: 'vault_list',
    description: 'Browse vault notes by category. Returns metadata without full content.',
    annotations: { readOnlyHint: true, openWorldHint: false },
    inputSchema: {
      type: 'object',
      properties: {
        category: { type: 'string', description: 'Filter: concepts, entities, projects, sessions, decisions, patterns, tools, postmortems, research, plans' },
        limit: { type: 'number', description: 'Max results (default: 30)' },
        sort: { type: 'string', enum: ['recent', 'name', 'links'], description: 'Sort order' },
      },
    },
  },
  {
    name: 'vault_recent_activity',
    description: 'List recent vault activity ordered by modified time with pagination.',
    annotations: { readOnlyHint: true, openWorldHint: false },
    inputSchema: {
      type: 'object',
      properties: {
        page: { type: 'number', description: '1-based page number (default: 1)' },
        page_size: { type: 'number', description: 'Rows per page (default: 10, max: 50)' },
        limit: { type: 'number', description: 'Alias for page_size' },
      },
    },
  },
  {
    name: 'vault_stats',
    description: 'Vault health and stats: page count, embeddings, categories, recent activity.',
    annotations: { readOnlyHint: true, openWorldHint: false },
    inputSchema: { type: 'object', properties: {} },
  },
];

function handleRequest(request) {
  const { method, params } = request;

  switch (method) {
    case 'initialize':
      return {
        protocolVersion: '2024-11-05',
        serverInfo: { name: 'alexandria', version: '2.0.0' },
        capabilities: { tools: {} },
      };

    case 'notifications/initialized':
      return undefined;

    case 'tools/list':
      return { tools: TOOLS };

    case 'tools/call': {
      const { name, arguments: args } = params || {};
      switch (name) {
        case 'vault_recall': return handleVaultRecall(args || {});
        case 'vault_search': return handleVaultSearch(args || {});
        case 'vault_read': return handleVaultRead(args || {});
        case 'vault_context': return handleVaultContext(args || {});
        case 'vault_write': return handleVaultWrite(args || {});
        case 'vault_auto_save': return handleVaultAutoSave(args || {});
        case 'vault_list': return handleVaultList(args || {});
        case 'vault_recent_activity': return handleVaultRecentActivity(args || {});
        case 'vault_stats': return handleVaultStats();
        default: return text(`Tool desconhecida: ${name}`);
      }
    }

    default:
      return { error: { code: -32601, message: `Unknown method: ${method}` } };
  }
}

function collectSearchResults(args) {
  refreshVaultIndex();
  const query = args.query || '';
  const limit = clampInteger(args.limit, 10, 1, 50);
  if (!query.trim()) return { error: 'Query vazia.', items: [] };

  const entityType = cleanInline(args.entity_type || 'note', 'note').toLowerCase();
  let results = [];
  if (entityType === 'observation') {
    results = searchObservationRows(query, args, limit);
  } else if (entityType === 'relation') {
    results = searchRelationRows(query, args, limit);
  } else if (entityType === 'all') {
    results = [
      ...filterNoteResults(applyRecencyBoost(hybridSearch(query, limit), query), args),
      ...searchObservationRows(query, args, limit),
      ...searchRelationRows(query, args, limit),
    ].sort((a, b) => (b.score || 0) - (a.score || 0)).slice(0, limit);
  } else {
    const searchType = cleanInline(args.search_type || 'hybrid', 'hybrid').toLowerCase();
    if (searchType === 'fts') {
      results = indexSearch(query, limit * 2);
    } else if (searchType === 'local_semantic') {
      results = semanticSearch(query, limit * 2).map(r => {
        const meta = sqliteRows(`SELECT title, category, summary, links, modified, permalink, substr(content, 1, 400) as snippet FROM pages WHERE path = '${escSql(r.path)}' LIMIT 1;`)[0] || {};
        return {
          item_type: 'note',
          path: r.path,
          title: meta.title || path.basename(r.path, '.md'),
          category: meta.category || '',
          permalink: meta.permalink || '',
          summary: meta.summary || '',
          snippet: meta.snippet || '',
          matched_text: meta.snippet || meta.summary || '',
          links: meta.links || 0,
          modified: meta.modified || '',
          score: r.similarity * 5,
        };
      });
    } else {
      results = hybridSearch(query, limit * 2);
    }
    results = filterNoteResults(applyRecencyBoost(results, query), args).slice(0, limit);
  }
  return { query, items: results };
}

function handleVaultSearch(args) {
  const packed = collectSearchResults(args);
  if (packed.error) return text(packed.error);
  if (packed.items.length === 0) {
    return text(`Nenhum resultado para "${packed.query}". Tente remover filtros, ampliar category/tags/agent, trocar entity_type/search_type, usar vault_list para navegar categorias, ou consultar vault_recent_activity.`);
  }
  const includeSnippets = args.include_snippets !== false;
  const lines = packed.items.map((result, index) => formatSearchResult(result, index, includeSnippets));
  return text(lines.join('\n\n'));
}

function upsertFrontmatterField(markdown, key, value) {
  const line = `${key}: ${value}`;
  if (!String(markdown).startsWith('---')) {
    return `---\n${line}\n---\n\n${markdown}`;
  }
  const end = markdown.indexOf('\n---', 3);
  if (end === -1) return markdown;
  let block = markdown.slice(3, end);
  const re = new RegExp(`^${key}:\\s*.*$`, 'mi');
  if (re.test(block)) block = block.replace(re, line);
  else block = `${block.replace(/\s+$/, '')}\n${line}`;
  return `---${block}\n---${markdown.slice(end + 4)}`;
}

function inboxBodyFromMarkdown(markdown, title) {
  let body = stripFrontmatter(markdown).trim();
  const escaped = String(title || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (escaped) {
    body = body.replace(new RegExp(`^#\\s+${escaped}\\s*$`, 'm'), '').trim();
  }
  return body;
}

function findInboxNote(args = {}) {
  refreshVaultIndex();
  const requestedPath = cleanInline(args.path || '', '');
  const requestedTitle = cleanInline(args.title || '', '');
  if (!requestedPath && !requestedTitle) {
    return { error: 'path or title is required', statusCode: 400 };
  }

  const tryResolve = (value) => {
    if (!value) return null;
    const resolved = resolveVaultReadPath(value);
    if (resolved.error || !resolved.filePath) return null;
    return resolved;
  };

  let resolved = tryResolve(requestedPath);
  if (!resolved && requestedPath) {
    resolved = tryResolve(requestedPath.replace(/^\/+/, ''));
    if (!resolved && !requestedPath.includes('/')) {
      resolved = tryResolve(`sessions/${requestedPath}`);
    }
  }
  if (!resolved && requestedTitle) {
    const slug = slugify(requestedTitle);
    resolved = tryResolve(`sessions/${slug}.md`);
    if (!resolved) {
      const row = sqliteRows(`
        SELECT path FROM pages
        WHERE category = 'sessions' AND title = '${escSql(requestedTitle)}' COLLATE NOCASE
        LIMIT 1;
      `)[0];
      if (row?.path) resolved = tryResolve(row.path);
    }
  }
  if (!resolved?.filePath) {
    return { error: 'inbox note not found', statusCode: 404 };
  }

  const relPath = resolved.relPath || relVaultRealPath(resolved.filePath);
  const normalized = String(relPath || '').replace(/\\/g, '/');
  if (!/(^|\/)sessions\//.test(normalized)) {
    return { error: 'inbox note not found', statusCode: 404 };
  }

  const content = fs.readFileSync(resolved.filePath, 'utf8');
  const metadata = parseFrontmatter(content);
  if (cleanInline(metadata.status || '', '').toLowerCase() !== 'inbox') {
    return { error: 'inbox note not found', statusCode: 404 };
  }

  return {
    filePath: resolved.filePath,
    relPath: normalized,
    content,
    metadata,
    title: cleanInline(metadata.title || requestedTitle || titleFromMarkdown(content, resolved.filePath)),
    kind: normalizeCaptureKind(metadata.kind),
  };
}

function markInboxPromoted(relPath, canonicalPath) {
  const relative = String(relPath || '').replace(/\\/g, '/').replace(/^\/+/, '');
  if (!relative || relative.split('/').includes('..')) return false;
  const candidate = path.join(VAULT_DIR, relative);
  const safe = safeVaultWritePath(candidate);
  if (!safe || !fs.existsSync(safe)) return false;
  let markdown = fs.readFileSync(safe, 'utf8');
  markdown = upsertFrontmatterField(markdown, 'status', 'promoted');
  markdown = upsertFrontmatterField(markdown, 'promoted_to', canonicalPath);
  fs.writeFileSync(safe, markdown);
  indexMarkdownFile(safe);
  return true;
}

function relationTargetMatchesPage(target, page) {
  const raw = cleanInline(target || '', '');
  if (!raw) return false;
  const needle = raw.replace(/\.md$/i, '').toLowerCase();
  const basename = path.basename(page.path || '', '.md').toLowerCase();
  const keys = new Set(
    [page.title, page.path, String(page.path || '').replace(/\.md$/i, ''), basename, page.permalink]
      .filter(Boolean)
      .map((value) => String(value).replace(/\.md$/i, '').toLowerCase()),
  );
  return keys.has(needle) || keys.has(path.basename(needle));
}

function collectGraphNeighbors(args = {}) {
  refreshVaultIndex();
  const requestedPath = cleanInline(args.path || '', '');
  const requestedTitle = cleanInline(args.title || '', '');
  if (!requestedPath && !requestedTitle) {
    return { error: 'path or title is required', statusCode: 400 };
  }

  let page = null;
  if (requestedPath) {
    const resolved = resolveVaultReadPath(requestedPath);
    if (resolved?.relPath) page = pageByPath(resolved.relPath);
    if (!page) page = pageByTitleOrPermalink(requestedPath);
  }
  if (!page && requestedTitle) {
    page = pageByTitleOrPermalink(requestedTitle);
  }
  if (!page) {
    return { error: 'note not found', statusCode: 404 };
  }

  const nodesByPath = new Map();
  const edges = [];
  const addNode = (candidate) => {
    if (!candidate?.path || nodesByPath.has(candidate.path)) return;
    if (nodesByPath.size >= 50) return;
    nodesByPath.set(candidate.path, {
      path: candidate.path,
      title: candidate.title,
      category: candidate.category || '',
      permalink: candidate.permalink || '',
    });
  };
  addNode(page);

  const outbound = relationsForPath(page.path);
  const outboundPages = pagesMatchingTargets(outbound.map((relation) => relation.target));
  for (const relation of outbound) {
    if (nodesByPath.size >= 50) break;
    const targetPage = matchPageForTarget(outboundPages, relation.target);
    if (!targetPage) continue;
    addNode(targetPage);
    if (!nodesByPath.has(targetPage.path)) continue;
    edges.push({
      from: page.path,
      to: targetPage.path,
      relation_type: relation.relation_type || 'links_to',
      direction: 'out',
    });
  }

  const identityKeys = graphIdentityKeys(page);
  const identityList = identityKeys.map((value) => `'${escSql(value)}'`).join(', ');
  const inbound = identityList ? sqliteRows(`
    SELECT path, relation_type, target
    FROM relations
    WHERE path != '${escSql(page.path)}'
      AND (
        target IN (${identityList})
        OR lower(replace(target, '.md', '')) IN (${identityKeys.map((value) => `'${escSql(String(value).replace(/\.md$/i, '').toLowerCase())}'`).join(', ')})
      )
    LIMIT 50
  `) : [];
  const inboundPages = pagesByPathList(inbound.map((rel) => rel.path));
  for (const rel of inbound) {
    if (nodesByPath.size >= 50) break;
    if (!relationTargetMatchesPage(rel.target, page)) continue;
    const sourcePage = inboundPages.get(rel.path);
    if (!sourcePage) continue;
    addNode(sourcePage);
    if (!nodesByPath.has(sourcePage.path)) continue;
    edges.push({
      from: sourcePage.path,
      to: page.path,
      relation_type: rel.relation_type || 'links_to',
      direction: 'in',
    });
  }

  return {
    source: nodesByPath.get(page.path),
    nodes: [...nodesByPath.values()],
    edges,
    depth: 1,
  };
}

function collectVaultHealth(args = {}) {
  refreshVaultIndex();
  const limit = clampInteger(args.limit, 20, 1, 100);
  const stats = mcpText(handleVaultStats());
  const pages = sqliteRows(`
    SELECT path, title, category, modified, permalink
    FROM pages
    WHERE path != 'hot.md'
  `);
  const relations = sqliteRows('SELECT path, target FROM relations;');

  const orphans = [];
  for (const page of pages) {
    const hasBacklink = relations.some((rel) => (
      rel.path !== page.path && relationTargetMatchesPage(rel.target, page)
    ));
    if (!hasBacklink) {
      orphans.push({ path: page.path, title: page.title, modified: page.modified || '' });
    }
  }

  const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
  const stale = pages
    .filter((page) => {
      const ts = Date.parse(page.modified);
      return Number.isFinite(ts) && ts < cutoff;
    })
    .map((page) => ({ path: page.path, title: page.title, modified: page.modified || '' }));

  const indexFailures = [...INDEX_FAILURES.entries()].slice(0, limit).map(([relPath, failure]) => ({
    path: relPath,
    message: failure.message,
    ts: failure.ts,
  }));

  return {
    stats,
    orphans: orphans.slice(0, limit),
    stale: stale.slice(0, limit),
    index_failures: indexFailures,
    counts: {
      pages: pages.length,
      orphans: orphans.length,
      stale: stale.length,
      index_failures: INDEX_FAILURES.size,
    },
  };
}

function dispatch(name, args = {}) {
  switch (name) {
    case 'vault_recall': return handleVaultRecall(args);
    case 'vault_search': return handleVaultSearch(args);
    case 'vault_read': return handleVaultRead(args);
    case 'vault_context': return handleVaultContext(args);
    case 'vault_write': return handleVaultWrite(args);
    case 'vault_auto_save': return handleVaultAutoSave(args);
    case 'vault_list': return handleVaultList(args);
    case 'vault_recent_activity': return handleVaultRecentActivity(args);
    case 'vault_stats': return handleVaultStats();
    default: return text(`Tool desconhecida: ${name}`);
  }
}

function mcpText(result) {
  return result?.content?.[0]?.text || '';
}

function ensureReady() {
  ensureVaultReady();
  loadEmbeddings();
  loadExpansionCache();
}

module.exports = {
  dispatch,
  ensureReady,
  handleRequest,
  TOOLS,
  mcpText,
  collectSearchResults,
  collectVaultHealth,
  collectGraphNeighbors,
  findInboxNote,
  inboxBodyFromMarkdown,
  markInboxPromoted,
  normalizeCaptureKind,
  CAPTURE_KINDS,
  getVaultDir: () => VAULT_DIR,
  getIndexDb: () => INDEX_DB,
  getStoreSizes: () => ({
    api: EMBEDDING_STORE.size,
    local: LOCAL_EMBEDDING_STORE.size,
    expansions: EXPANSION_CACHE.size,
  }),
  log,
};
