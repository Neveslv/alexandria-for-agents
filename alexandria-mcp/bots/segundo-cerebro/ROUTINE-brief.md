# Routine: brief diário (~5 min)

1. Subir a ponte: `node http/server.js` (ou `bin/alexandria-http`) com o mesmo `ALEXANDRIA_VAULT_DIR` do MCP.
2. `GET /v1/recent?page_size=8`
3. `POST /v1/ask` com `{"query": "hoje projetos bloqueios decisões"}`
4. Responder em 5 linhas: o que está quente, o que mudou, 1 next action.
5. Se o usuário colar um fato novo, usar `/v1/capture` **sem** confirm, mostrar candidatos, só então confirmar.
