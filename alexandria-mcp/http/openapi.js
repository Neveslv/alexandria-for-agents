'use strict';

module.exports = {
  openapi: '3.0.3',
  info: {
    title: 'Alexandria HTTP v1',
    version: '1.0.0',
    description: 'Loopback API for Grok Bot (Segundo cérebro). Same vault as the MCP server.',
  },
  servers: [{ url: 'http://127.0.0.1:8787' }],
  paths: {
    '/': {
      get: {
        summary: 'Local SPA (web/index.html)',
        responses: { 200: { description: 'HTML shell' } },
      },
    },
    '/app.js': {
      get: { summary: 'SPA script from web/', responses: { 200: { description: 'JavaScript' }, 404: { description: 'missing static file' } } },
    },
    '/styles.css': {
      get: { summary: 'SPA styles from web/', responses: { 200: { description: 'CSS' } } },
    },
    '/v1/healthz': {
      get: { summary: 'Process liveness', responses: { 200: { description: 'ok' } } },
    },
    '/v1/ask': {
      post: {
        summary: 'Recall + search, no writes',
        requestBody: {
          required: true,
          content: { 'application/json': { schema: { type: 'object', required: ['query'], properties: { query: { type: 'string' }, max_tokens: { type: 'number' }, limit: { type: 'number' } } } } },
        },
        responses: { 200: { description: 'recall and search text' } },
      },
    },
    '/v1/search': {
      post: {
        summary: 'Proxy vault_search',
        requestBody: {
          required: true,
          content: { 'application/json': { schema: { type: 'object', required: ['query'], properties: { query: { type: 'string' }, limit: { type: 'number' } } } } },
        },
        responses: { 200: { description: 'items + formatted text' } },
      },
    },
    '/v1/recent': {
      get: { summary: 'Recent vault activity', responses: { 200: { description: 'activity text' } } },
    },
    '/v1/capture': {
      post: {
        summary: 'Ask-before-write inbox capture',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['text'],
                properties: {
                  text: { type: 'string' },
                  title: { type: 'string' },
                  kind: { type: 'string', enum: ['fact', 'decision', 'procedure', 'gotcha'] },
                  query: { type: 'string' },
                  confirm: { type: 'boolean' },
                },
              },
            },
          },
        },
        responses: { 200: { description: 'preview or written inbox note' } },
      },
    },
    '/v1/promote': {
      post: {
        summary: 'Promote an inbox session note to a canonical category',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  path: { type: 'string', description: 'Inbox note path under sessions/' },
                  title: { type: 'string', description: 'Inbox title lookup, or canonical title when path is set' },
                  category: { type: 'string', description: 'Target category (default: decisions if kind=decision, else concepts)' },
                  overwrite: { type: 'boolean' },
                },
              },
            },
          },
        },
        responses: {
          200: { description: 'Canonical note written; inbox marked promoted' },
          400: { description: 'path or title required' },
          404: { description: 'inbox not found' },
          409: { description: 'canonical exists and overwrite is not true' },
        },
      },
    },
    '/v1/vault/health': {
      get: {
        summary: 'Vault stats plus orphans, stale notes, and index failures',
        parameters: [
          { name: 'limit', in: 'query', schema: { type: 'integer', default: 20 } },
        ],
        responses: { 200: { description: 'stats, orphans, stale, index_failures' } },
      },
    },
    '/v1/graph': {
      get: {
        summary: 'Neighbors of a note (wikilinks + relations, depth=1, max 50 nodes)',
        parameters: [
          { name: 'path', in: 'query', schema: { type: 'string' }, description: 'Vault-relative note path' },
          { name: 'title', in: 'query', schema: { type: 'string' }, description: 'Note title lookup' },
        ],
        responses: {
          200: { description: 'source, nodes, edges' },
          400: { description: 'path or title required' },
          404: { description: 'note not found' },
        },
      },
    },
    '/v1/note': {
      get: {
        summary: 'Full markdown of one note, for the reader pane',
        parameters: [
          {
            name: 'path',
            in: 'query',
            required: true,
            schema: { type: 'string' },
            description: 'Vault-relative note path, title or memory:// permalink',
          },
        ],
        responses: {
          200: { description: 'path and content' },
          400: { description: 'path required or outside the vault' },
          404: { description: 'note not found' },
        },
      },
    },
  },
};
