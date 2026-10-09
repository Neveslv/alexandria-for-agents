# Alexandria Codex MCP

Use Alexandria como memória Markdown/Obsidian de longo prazo para o Codex.

## Quando Consultar

- No começo de tarefas não triviais em que contexto anterior pode mudar a resposta.
- Antes de implementar algo que dependa de decisões, padrões ou histórico do projeto.
- Quando o usuário perguntar "o que fizemos", "qual era a decisão", "onde está" ou algo parecido.

## Tools Recomendadas

| Situação | Tool |
|----------|------|
| Contexto inicial rápido | `vault_recall` |
| Busca direcionada | `vault_search` |
| Ler uma nota completa | `vault_read` |
| Montar pacote de contexto | `vault_context` |
| Criar nota manual | `vault_write` |
| Salvar resumo de sessão | `vault_auto_save` |
| Navegar categorias | `vault_list` |
| Ver atividade recente | `vault_recent_activity` |
| Ver saúde do vault | `vault_stats` |

## Boas Práticas

- Não invente contexto: se Alexandria não trouxer resultado, diga isso claramente.
- Use `vault_context` quando `vault_recall` trouxer pistas, mas não detalhe suficiente.
- Use `vault_context` com `source: "memory://..."` quando precisar seguir relações e wikilinks a partir de uma nota específica.
- Use `vault_search` com `entity_type: "observation"` para fatos categorizados como `[decision]`, `[risk]`, `[action]` ou similares.
- Use `vault_search` com `entity_type: "relation"` e `relation_type` quando a pergunta for sobre dependências ou conexões entre notas.
- Use `vault_search` com `agent` para filtrar por quem escreveu (frontmatter); `namespace` é legado e mapeia para `agent`.
- Use `include_snippets: false` em `vault_search` quando precisar apenas de lista/citações e não do trecho encontrado.
- Prefira `memory://<permalink>` para referências duráveis quando uma nota tiver frontmatter `permalink`.
- Salve conhecimento apenas quando houver valor real para recuperar depois: decisão, padrão, bug difícil, configuração ou resumo de sessão produtiva.
- Evite salvar segredos, tokens, credenciais, dados pessoais sensíveis ou conteúdo que não deveria ficar em Markdown local.
- Use `overwrite: false` em `vault_write` quando quiser evitar substituir uma nota existente por acidente.
- Verifique `vault_stats` se uma busca parecer desatualizada; ele mostra falhas recentes de indexação.
- Grave em categorias raiz (`patterns/`, `decisions/`, …), nunca em pastas `Codex/`, `Nitro/`, `shared/` ou `Cursor/`.

## Formato Semântico

Alexandria indexa Markdown normal e também reconhece linhas de observação e relação:

```markdown
- [decision] Writes go to root categories; agent stays in frontmatter #codex
- depends_on [[Shared Vault Policy]] (contrato compartilhado)
```

Observações e relações continuam legíveis no Obsidian e aparecem como resultados citáveis em `vault_search`.

## Configuração

Por padrão, o MCP usa:

- Vault: `~/Documents/AI_memory/graph_memory/Alexandria/wiki`
- Índice: `~/.codex/mcp-servers/alexandria/.vault-index.db`

Você pode sobrescrever com variáveis de ambiente:

- `ALEXANDRIA_VAULT_DIR`
- `ALEXANDRIA_NAMESPACE` (só provenance/`agent` em writes; não prefixa path)
- `ALEXANDRIA_INDEX_DB`
- `ALEXANDRIA_SETTINGS_PATH`
- `ALEXANDRIA_EXPANSION_CACHE`

Novas notas vão para `<vault>/<category>/` (ex.: `patterns/Foo.md`). Coloque `agent` e `source` no frontmatter; `ALEXANDRIA_NAMESPACE=Codex` preenche `agent: Codex` sem criar pasta `Codex/`. `_archive/**` não é indexado.

Expansão LLM remota fica desligada por padrão. Só habilite se `ALEXANDRIA_SETTINGS_PATH` tiver `allowRemoteExpansion: true` junto de `apiKey` e `endpoint`; nesse modo, queries de busca podem ser enviadas ao endpoint definido.
