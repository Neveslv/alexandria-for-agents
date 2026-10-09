# HTTP tools — Segundo cérebro

Base: `http://127.0.0.1:8787`

OpenAPI: `GET http://127.0.0.1:8787/openapi.json`

## healthz

```bash
curl -sS http://127.0.0.1:8787/v1/healthz
```

## ask (não escreve)

```bash
curl -sS -X POST http://127.0.0.1:8787/v1/ask \
  -H 'content-type: application/json' \
  -d '{"query":"alexandria vault kernel"}'
```

## search

```bash
curl -sS -X POST http://127.0.0.1:8787/v1/search \
  -H 'content-type: application/json' \
  -d '{"query":"alexandria","limit":5}'
```

## recent

```bash
curl -sS 'http://127.0.0.1:8787/v1/recent?page_size=8'
```

## capture (preview)

```bash
curl -sS -X POST http://127.0.0.1:8787/v1/capture \
  -H 'content-type: application/json' \
  -d '{"title":"Inbox fact","kind":"fact","text":"Texto cru da reunião."}'
```

## capture (grava inbox)

```bash
curl -sS -X POST http://127.0.0.1:8787/v1/capture \
  -H 'content-type: application/json' \
  -d '{"title":"Inbox fact","kind":"fact","text":"Texto cru da reunião.","confirm":true}'
```

## token (opcional)

```bash
curl -sS -X POST http://127.0.0.1:8787/v1/ask \
  -H 'content-type: application/json' \
  -H 'X-Alexandria-Token: SEU_TOKEN' \
  -d '{"query":"hoje"}'
```

## promote (inbox → canônico)

Body: `{ path | title, category?, title?, overwrite? }`. Default: `kind=decision` → `decisions/`, senão `concepts/`. 404 se a inbox não existir; 409 se o canônico já existir e `overwrite` não for `true`.

```bash
curl -sS -X POST http://127.0.0.1:8787/v1/promote \
  -H 'content-type: application/json' \
  -d '{"path":"sessions/Inbox-fact.md"}'
```

A inbox fica com `status: promoted` e `promoted_to: <path canônico>`.

## vault health

`limit` default 20. Resposta: `stats` (texto do `vault_stats`), `orphans` (sem backlinks), `stale` (mtime > 30 dias), `index_failures`.

```bash
curl -sS 'http://127.0.0.1:8787/v1/vault/health?limit=20'
```

## graph (vizinhos)

`path` ou `title`. Depth=1 (wikilinks + relations). Máx. 50 nós.

```bash
curl -sS 'http://127.0.0.1:8787/v1/graph?title=Existing%20Note'
curl -sS 'http://127.0.0.1:8787/v1/graph?path=concepts/Existing-Note.md'
```

## note (nota inteira)

`path` aceita caminho relativo, título ou permalink `memory://`.

```bash
curl -sS 'http://127.0.0.1:8787/v1/note?path=concepts/Existing-Note.md'
```

## UI local

Abra `http://127.0.0.1:8787` (SPA em `web/`), com quatro seções:

| Seção | O que faz | Endpoints |
|-------|-----------|-----------|
| Buscar | Procura no vault e abre a nota no leitor ao lado | `POST /v1/ask`, `GET /v1/note` |
| Capturas | Lista rascunhos com tag `inbox` e promove para nota canônica | `POST /v1/search`, `POST /v1/promote` |
| Conexões | Mostra o que a nota cita e quem cita ela, navegável | `GET /v1/graph`, `GET /v1/note` |
| Saúde | Órfãs, paradas >30d e falhas de índice | `GET /v1/vault/health` |
