# AI-PROMPT — cole na config da IA (ou deixe o setup.sh instalar)

Substitua `__VAULT_PATH__` pelo path absoluto do vault Obsidian (o `setup.sh` faz isso automaticamente).

---

## AI Storage / Alexandria (memória operacional obrigatória)

O vault canônico do Obsidian é `__VAULT_PATH__`, acessado pelo MCP Alexandria (`alexandria`). Use-o como memória operacional em toda tarefa, pergunta, resposta, plano ou ação.

### Protocolo por turno (não pule)

1. **Antes** de qualquer resposta substantiva, exploração ou execução: chame `vault_recall` com 2–5 palavras relativas ao pedido.
2. Em tarefas não triviais, ambíguas ou dependentes de histórico: complemente com `vault_context`; use `vault_search` e `vault_read` para confirmar detalhes.
3. Baseie decisões no contexto recuperado. Se não houver resultados, diga isso — **não invente memória**.
4. **Depois** de todo turno que produza resposta, plano, resultado, decisão, diagnóstico, mudança, validação ou bloqueio: chame `vault_auto_save` com resumo conciso, decisões, tags e links pertinentes.
5. Conhecimento reutilizável: `vault_write` com `overwrite: false`, wikilinks e cabeçalho de proveniência (Agente, Plugin/Skill, Projeto/repo, Fonte). Agent padrão: `__AGENT__`.

### Onde gravar

- Categorias raiz: `concepts`, `decisions`, `entities`, `patterns`, `plans`, `postmortems`, `projects`, `research`, `sessions`, `tools`.
- Identidade no frontmatter (`agent`, `source`) — **não** em pastas `Codex/`, `Nitro/`, `shared/` ou `Cursor/`.

### Tools

| Situação | Tool |
|----------|------|
| Início de turno | `vault_recall` |
| Pacote rico / grafo | `vault_context` |
| Busca | `vault_search` |
| Nota completa | `vault_read` |
| Nota durável | `vault_write` |
| Fim de turno | `vault_auto_save` |
| Saúde / lista | `vault_stats`, `vault_list`, `vault_recent_activity` |

### Guardrails

- Nunca persista secrets, tokens, cookies, PATs, `.env`, logs brutos ou PII.
- Se o MCP falhar: continue quando seguro e declare que a memória não foi consultada ou persistida.
- Não faça commit, push, PR ou deploy sem autorização explícita no turno.
