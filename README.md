# Alexandria for Agents

Memória persistente para agentes de IA, guardada como Markdown em um vault Obsidian e acessada por ferramentas MCP. Alexandria conecta o contexto de uma sessão às próximas: o agente consulta o vault no início do trabalho, executa a tarefa e salva um resumo ao final.

## O que faz

- Lê e grava notas Markdown no vault local do usuário.
- Indexa o vault em SQLite para busca textual e semântica local.
- Oferece ferramentas MCP como `vault_recall`, `vault_search`, `vault_read`, `vault_context`, `vault_write`, `vault_auto_save` e `vault_stats`.
- Instala o servidor e, nos clientes suportados, registra o MCP e ativa instruções persistentes para o agente usar Alexandria automaticamente.
- Inclui uma API HTTP local e uma interface web opcional para pesquisar e navegar pelo vault.

Os arquivos Markdown permanecem legíveis e editáveis no Obsidian. O índice SQLite é auxiliar e pode ser recriado a partir das notas. A instalação é local; nenhuma chave de API é necessária para a busca padrão.

## Requisitos

- Node.js 18 ou mais recente
- SQLite 3 (`sqlite3`) disponível no `PATH`
- Um vault Obsidian existente ou um diretório que você deseja inicializar
- Um dos clientes suportados para integração automática: Codex CLI, Cursor, Claude Code ou Gemini CLI

Os próprios clientes são instalados separadamente.

## Instalação

Clone o repositório e rode o instalador, informando o caminho absoluto do vault e o cliente:

### Windows PowerShell

```powershell
git clone https://github.com/Neveslv/alexandria-for-agents.git
cd alexandria-for-agents
node .\install.js --vault "C:\Users\seu-usuario\Alexandria" --client codex
```

### macOS ou Linux

```bash
git clone https://github.com/Neveslv/alexandria-for-agents.git
cd alexandria-for-agents
node install.js --vault "$HOME/Documents/Alexandria" --client codex
```

Opções de cliente: `codex`, `cursor`, `claude-code`, `gemini-cli` ou `all`. `all` configura os clientes suportados que estiverem disponíveis; instale cada cliente antes de executar o instalador. Para ver as opções, rode `node install.js --help`.

O instalador copia o servidor para `~/.alexandria/mcp-server/`, inicializa o vault e seu índice, e configura o cliente escolhido. Nos arquivos JSON, preserva as demais entradas e cria um backup antes de gravar. Se o Codex ou o Claude Code já tiverem um servidor MCP chamado Alexandria, a entrada existente é mantida. A instalação pode ser simulada com `--dry-run`.

| Cliente | Registro MCP | Instruções sempre ativas |
| --- | --- | --- |
| Codex | `codex mcp add` | `~/.codex/AGENTS.md` |
| Cursor | `~/.cursor/mcp.json` | `~/.cursor/rules/alexandria.mdc` |
| Claude Code | `claude mcp add --scope user` | `~/.claude/CLAUDE.md` |
| Gemini CLI | `~/.gemini/settings.json` | `~/.gemini/GEMINI.md` |

As instruções ensinam o agente a consultar a memória antes do trabalho e a salvar um resumo depois. O instalador acrescenta ou atualiza apenas o bloco de Alexandria nos arquivos de instrução existentes.

## Como usar

1. Reinicie ou recarregue o cliente após a instalação e abra uma nova conversa.
2. Peça ao agente para executar `vault_stats` e confirme que o servidor está conectado.
3. Converse normalmente. As instruções instaladas orientam o agente a chamar `vault_recall` antes de responder e `vault_auto_save` ao final.
4. Para registrar um conhecimento que deve ser recuperado depois, use `vault_write` com `overwrite: false`.
5. Abra no Obsidian a mesma pasta informada ao instalador para visualizar e editar as notas.

Para outro cliente compatível com MCP, use a configuração local do servidor:

```json
{
  "mcpServers": {
    "alexandria": {
      "command": "node",
      "args": ["/caminho/para/.alexandria/mcp-server/server.js"],
      "env": {
        "ALEXANDRIA_VAULT_DIR": "/caminho/absoluto/do/vault",
        "ALEXANDRIA_NAMESPACE": "Nome do agente",
        "ALEXANDRIA_INDEX_DB": "/caminho/para/.alexandria/vault-index.db"
      }
    }
  }
}
```

O formato e o local do arquivo de configuração variam entre os clientes. Clientes sem um dos instaladores integrados também precisam receber `AI-PROMPT.md` nas instruções persistentes para adotar o fluxo de memória automaticamente.

## Configuração e privacidade

O instalador não pede credenciais. O servidor lê e grava no caminho passado em `--vault`; não envie segredos, tokens, cookies, `.env`, logs brutos ou dados pessoais sensíveis para as notas. A expansão remota por LLM permanece desativada por padrão.

Variáveis do servidor:

| Variável | Uso |
| --- | --- |
| `ALEXANDRIA_VAULT_DIR` | Caminho absoluto do vault |
| `ALEXANDRIA_NAMESPACE` | Proveniência do agente nas novas notas |
| `ALEXANDRIA_INDEX_DB` | Caminho do índice SQLite local |
| `ALEXANDRIA_SETTINGS_PATH` | Configuração opcional de expansão de busca |
| `ALEXANDRIA_EXPANSION_CACHE` | Cache local de expansão de busca |

## Componentes

- `alexandria-mcp/` — servidor MCP, kernel do vault, ponte HTTP e interface local.
- `install.js` — instalador multiplataforma para os clientes listados acima.
- `AI-PROMPT.md` — instruções de memória para agentes.
- `rules/alexandria.mdc` — regra always-on do Cursor.
- `INSTRUCTIONS-FOR-AI.md` — checklist para agentes que auxiliam na instalação.

## Autoria

Criado por **Neves e Nicolas Vlad**.
