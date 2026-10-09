'use strict';

const fs = require('node:fs');
const path = require('node:path');

const {
  dispatch,
  ensureReady,
  mcpText,
  collectSearchResults,
  collectVaultHealth,
  collectGraphNeighbors,
  findInboxNote,
  inboxBodyFromMarkdown,
  markInboxPromoted,
  normalizeCaptureKind,
} = require('../lib/kernel');

const OPENAPI = require('./openapi');

const WEB_ROOT = path.resolve(__dirname, '..', 'web');
const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
};

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);
const MUTATING_PATHS = new Set(['/v1/capture', '/v1/promote']);

function assertLoopbackHost(host) {
  const normalized = String(host || '127.0.0.1').trim();
  if (!LOOPBACK_HOSTS.has(normalized)) {
    const err = new Error(`ALEXANDRIA_HTTP_HOST must be loopback (127.0.0.1), got ${normalized}`);
    err.code = 'not_loopback';
    throw err;
  }
  return normalized === 'localhost' ? '127.0.0.1' : normalized;
}

function requestHostname(hostHeader) {
  const raw = String(hostHeader || '').split(',')[0].trim().toLowerCase();
  if (!raw) return '';
  if (raw.startsWith('[')) {
    const end = raw.indexOf(']');
    if (end === -1) return '';
    return raw.slice(1, end);
  }
  const colon = raw.lastIndexOf(':');
  if (colon !== -1 && /^\d+$/.test(raw.slice(colon + 1))) {
    return raw.slice(0, colon);
  }
  return raw;
}

function isLoopbackRequestHost(hostHeader) {
  return LOOPBACK_HOSTS.has(requestHostname(hostHeader));
}

function originHostname(origin) {
  try {
    return new URL(String(origin)).hostname.replace(/^\[|\]$/g, '').toLowerCase();
  } catch {
    return '';
  }
}

function isMutatingCrossSite(req) {
  const site = String(req.headers['sec-fetch-site'] || '').toLowerCase();
  if (site === 'cross-site') return true;
  const origin = req.headers.origin;
  if (origin == null || origin === '') return false;
  return !LOOPBACK_HOSTS.has(originHostname(origin));
}

function json(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

function tryServeStatic(req, res, pathname) {
  if (req.method !== 'GET') return false;
  if (pathname.startsWith('/v1/') || pathname === '/openapi.json') return false;

  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    json(res, 404, { error: 'not_found', message: pathname });
    return true;
  }
  if (decoded.includes('\0')) {
    json(res, 404, { error: 'not_found', message: pathname });
    return true;
  }

  const rel = decoded === '/' ? 'index.html' : decoded.replace(/^\/+/, '');
  if (!rel || rel.split(/[/\\]/).includes('..')) {
    json(res, 404, { error: 'not_found', message: pathname });
    return true;
  }

  const candidate = path.resolve(WEB_ROOT, rel);
  const relative = path.relative(WEB_ROOT, candidate);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    json(res, 404, { error: 'not_found', message: pathname });
    return true;
  }
  let stat;
  try {
    stat = fs.statSync(candidate);
  } catch {
    json(res, 404, { error: 'not_found', message: pathname });
    return true;
  }
  if (!stat.isFile()) {
    json(res, 404, { error: 'not_found', message: pathname });
    return true;
  }

  const ext = path.extname(candidate).toLowerCase();
  const body = fs.readFileSync(candidate);
  res.writeHead(200, {
    'content-type': MIME_TYPES[ext] || 'application/octet-stream',
    'content-length': body.length,
  });
  res.end(body);
  return true;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw.trim()) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch (error) {
        error.statusCode = 400;
        reject(error);
      }
    });
    req.on('error', reject);
  });
}

function tokenOk(req) {
  const expected = process.env.ALEXANDRIA_HTTP_TOKEN;
  if (!expected) return true;
  const got = req.headers['x-alexandria-token'];
  return got === expected;
}

function candidatesFromSearch(query, limit = 5) {
  const packed = collectSearchResults({ query, limit });
  if (packed.error) return [];
  return packed.items.map((item) => ({
    title: item.title,
    path: item.path,
    permalink: item.permalink || '',
    category: item.category || '',
    snippet: (item.matched_text || item.summary || item.snippet || '').slice(0, 400),
  }));
}

function buildDraft(body) {
  const raw = String(body.text || body.content || '').trim();
  const kind = normalizeCaptureKind(body.kind) || 'fact';
  const title = String(body.title || raw.split('\n')[0] || 'Inbox capture').slice(0, 120);
  return {
    title,
    kind,
    category: 'sessions',
    status: 'inbox',
    content: raw,
  };
}

function handlePromote(body) {
  const inbox = findInboxNote({
    path: body.path,
    title: body.title,
  });
  if (inbox.error) {
    return {
      status: inbox.statusCode || 400,
      body: {
        error: inbox.statusCode === 404 ? 'not_found' : 'invalid_request',
        message: inbox.error,
      },
    };
  }

  const kind = normalizeCaptureKind(body.kind) || inbox.kind;
  const category = String(body.category || (kind === 'decision' ? 'decisions' : 'concepts')).trim();
  const title = String(body.canonical_title || body.title || inbox.title).trim();
  const content = inboxBodyFromMarkdown(inbox.content, inbox.title) || String(inbox.content || '').trim();
  if (!title || !content) {
    return { status: 400, body: { error: 'invalid_request', message: 'title and content are required' } };
  }

  const written = dispatch('vault_write', {
    title,
    content,
    category,
    tags: ['promoted', kind].filter(Boolean),
    overwrite: body.overwrite === true,
    kind,
    status: 'canonical',
  });
  const message = mcpText(written);
  if (message.startsWith('Nota já existe:')) {
    return { status: 409, body: { error: 'conflict', message } };
  }
  if (message.startsWith('Categoria inválida')) {
    return { status: 400, body: { error: 'invalid_request', message } };
  }
  const relMatch = message.match(/Nota salva: (.+)/);
  if (!relMatch) {
    return { status: 500, body: { error: 'internal_error', message } };
  }
  const canonicalPath = relMatch[1].split('\n')[0].trim();
  if (!markInboxPromoted(inbox.relPath, canonicalPath)) {
    return { status: 500, body: { error: 'internal_error', message: 'Failed to mark inbox as promoted' } };
  }
  return {
    status: 200,
    body: {
      written: true,
      inbox_path: inbox.relPath,
      canonical_path: canonicalPath,
      category,
      message,
    },
  };
}

function handleCapture(body) {
  const draft = buildDraft(body);
  if (!draft.content) {
    return { status: 400, body: { error: 'invalid_request', message: 'text is required' } };
  }
  const query = String(body.query || draft.title);
  const candidates = candidatesFromSearch(query);
  if (!body.confirm) {
    return {
      status: 200,
      body: { confirm_required: true, candidates, draft },
    };
  }
  const written = dispatch('vault_write', {
    title: draft.title,
    content: draft.content,
    category: 'sessions',
    tags: ['inbox', 'capture', draft.kind],
    overwrite: false,
    status: 'inbox',
    kind: draft.kind,
  });
  const message = mcpText(written);
  const relMatch = message.match(/Nota salva: (.+)/);
  return {
    status: 200,
    body: {
      confirm_required: false,
      written: true,
      path: relMatch ? relMatch[1].split('\n')[0].trim() : '',
      message,
      candidates,
      draft,
    },
  };
}

async function handle(req, res) {
  const url = new URL(req.url || '/', 'http://127.0.0.1');
  const pathname = url.pathname.replace(/\/$/, '') || '/';

  if (!isLoopbackRequestHost(req.headers.host)) {
    json(res, 403, { error: 'forbidden', message: 'Host header must be loopback' });
    return;
  }

  if (pathname === '/v1/healthz' && req.method === 'GET') {
    json(res, 200, { ok: true });
    return;
  }

  if (tryServeStatic(req, res, pathname)) return;

  if (!tokenOk(req)) {
    json(res, 401, { error: 'unauthorized', message: 'Missing or invalid X-Alexandria-Token' });
    return;
  }

  if (
    MUTATING_PATHS.has(pathname)
    && req.method === 'POST'
    && !process.env.ALEXANDRIA_HTTP_TOKEN
    && isMutatingCrossSite(req)
  ) {
    json(res, 403, { error: 'forbidden', message: 'Cross-site mutation is not allowed without a token' });
    return;
  }

  if (pathname === '/openapi.json' && req.method === 'GET') {
    json(res, 200, OPENAPI);
    return;
  }

  if (pathname === '/v1/graph' && req.method === 'GET') {
    const result = collectGraphNeighbors({
      path: url.searchParams.get('path') || '',
      title: url.searchParams.get('title') || '',
    });
    if (result.error) {
      json(res, result.statusCode || 400, {
        error: result.statusCode === 404 ? 'not_found' : 'invalid_request',
        message: result.error,
      });
      return;
    }
    json(res, 200, result);
    return;
  }

  try {
    if (pathname === '/v1/promote' && req.method === 'POST') {
      const body = await readBody(req);
      const result = handlePromote(body);
      json(res, result.status, result.body);
      return;
    }

    if (pathname === '/v1/vault/health' && req.method === 'GET') {
      const limit = Number(url.searchParams.get('limit') || 20);
      json(res, 200, collectVaultHealth({ limit }));
      return;
    }

    if (pathname === '/v1/ask' && req.method === 'POST') {
      const body = await readBody(req);
      const query = String(body.query || '').trim();
      if (!query) {
        json(res, 400, { error: 'invalid_request', message: 'query is required' });
        return;
      }
      const limit = body.limit || 8;
      const recall = mcpText(dispatch('vault_recall', { query, max_tokens: body.max_tokens }));
      const search = mcpText(dispatch('vault_search', { query, limit }));
      const packed = collectSearchResults({ query, limit });
      json(res, 200, { query, recall, search, items: packed.items || [] });
      return;
    }

    if (pathname === '/v1/note' && req.method === 'GET') {
      const notePath = String(url.searchParams.get('path') || '').trim();
      if (!notePath) {
        json(res, 400, { error: 'invalid_request', message: 'path is required' });
        return;
      }
      const content = mcpText(dispatch('vault_read', { path: notePath }));
      if (content.startsWith('Nota não encontrada:')) {
        json(res, 404, { error: 'not_found', message: content });
        return;
      }
      if (content.startsWith('Path obrigatório') || content.startsWith('Path fora do vault')) {
        json(res, 400, { error: 'invalid_request', message: content });
        return;
      }
      json(res, 200, { path: notePath, content });
      return;
    }

    if (pathname === '/v1/search' && req.method === 'POST') {
      const body = await readBody(req);
      const query = String(body.query || '').trim();
      if (!query) {
        json(res, 400, { error: 'invalid_request', message: 'query is required' });
        return;
      }
      const packed = collectSearchResults({ ...body, query });
      json(res, 200, {
        query,
        items: packed.items,
        text: mcpText(dispatch('vault_search', { ...body, query })),
      });
      return;
    }

    if (pathname === '/v1/recent' && req.method === 'GET') {
      const page = Number(url.searchParams.get('page') || 1);
      const page_size = Number(url.searchParams.get('page_size') || url.searchParams.get('limit') || 10);
      json(res, 200, {
        text: mcpText(dispatch('vault_recent_activity', { page, page_size })),
      });
      return;
    }

    if (pathname === '/v1/capture' && req.method === 'POST') {
      const body = await readBody(req);
      const result = handleCapture(body);
      json(res, result.status, result.body);
      return;
    }
  } catch (error) {
    json(res, error.statusCode || 500, { error: 'internal_error', message: error.message });
    return;
  }

  json(res, 404, { error: 'not_found', message: pathname });
}

function createHandler() {
  ensureReady();
  return handle;
}

module.exports = {
  assertLoopbackHost,
  createHandler,
  LOOPBACK_HOSTS,
};
