# Alexandria for Agents

[English](README.md) | [Português (Brasil)](README.pt-BR.md)

Memória persistente e local-first para agentes de IA, armazenada como Markdown em um vault Obsidian e acessada por ferramentas MCP. Alexandria leva contexto útil de uma sessão para a seguinte: o agente recupera notas relevantes antes de trabalhar e salva um resumo conciso ao terminar.

## O que faz

- Lê e grava notas Markdown no vault local.
- Indexa o vault em SQLite para busca textual completa e semântica local.
- Oferece ferramentas MCP como `vault_recall`, `vault_search`, `vault_read`, `vault_context`, `vault_write`, `vault_auto_save` e `vault_stats`.
- Instala o servidor e, nos clientes compatíveis, registra o MCP e adiciona instruções persistentes para o agente usar Alexandria automaticamente.
- Inclui uma API HTTP local e uma interface web opcional para pesquisar e navegar pelo vault.

Os arquivos Markdown continuam legíveis e editáveis no Obsidian. O índice SQLite é auxiliar e pode ser recriado a partir das notas. A instalação é local; a busca padrão não exige chave de API.

## Requisitos

- Node.js 18 ou mais recente
- SQLite 3 (`sqlite3`) disponível no `PATH`
- Um vault Obsidian existente ou um diretório que você queira inicializar
- Para integração automática: Codex CLI, Cursor, Claude Code ou Gemini CLI

Instale os clientes de IA separadamente.

## Instalação

Clone o repositório e rode o instalador informando o caminho absoluto do vault e o cliente a configurar.

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

Clientes suportados: `codex`, `cursor`, `claude-code`, `gemini-cli` ou `all`. A opção `all` configura todos os clientes suportados que estiverem disponíveis; instale cada cliente antes de executar o instalador. Para ver todas as opções, rode `node install.js --help`.

O instalador copia o servidor para `~/.alexandria/mcp-server/`, inicializa o vault e seu índice e configura o cliente escolhido. Ele preserva as demais entradas nos arquivos de configuração JSON e cria backups antes de alterá-los. Se Codex ou Claude Code já tiverem um servidor MCP chamado Alexandria, a entrada existente será mantida. Use `--dry-run` para simular a instalação.

| Cliente | Registro MCP | Instruções persistentes |
| --- | --- | --- |
| Codex | `codex mcp add` | `~/.codex/AGENTS.md` |
| Cursor | `~/.cursor/mcp.json` | `~/.cursor/rules/alexandria.mdc` |
| Claude Code | `claude mcp add --scope user` | `~/.claude/CLAUDE.md` |
| Gemini CLI | `~/.gemini/settings.json` | `~/.gemini/GEMINI.md` |

As instruções instaladas orientam o agente a consultar a memória antes de trabalhar e salvar um resumo ao terminar. O instalador acrescenta ou atualiza apenas o bloco de Alexandria nos arquivos de instrução existentes.

## Como usar

1. Reinicie ou recarregue o cliente escolhido e abra uma nova conversa.
2. Peça ao agente para executar `vault_stats` e confirme que o servidor está conectado.
3. Trabalhe normalmente. As instruções instaladas orientam o agente a chamar `vault_recall` antes de responder e `vault_auto_save` ao final.
4. Para salvar conhecimento para recuperação futura, use `vault_write` com `overwrite: false`.
5. Abra no Obsidian a mesma pasta informada ao instalador para visualizar e editar as notas.

Para outro cliente compatível com MCP, configure manualmente o servidor local:

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

Os formatos e locais dos arquivos de configuração variam entre clientes. Clientes sem um adaptador integrado também precisam receber o `AI-PROMPT.md` nas instruções persistentes para seguir o fluxo de memória automaticamente.

## Configuração e privacidade

O instalador não solicita credenciais. O servidor lê e grava apenas no caminho passado em `--vault`. Não salve segredos, tokens, cookies, arquivos `.env`, logs brutos ou dados pessoais sensíveis nas notas. A expansão remota de busca com LLM fica desativada por padrão.

Variáveis de ambiente do servidor:

| Variável | Finalidade |
| --- | --- |
| `ALEXANDRIA_VAULT_DIR` | Caminho absoluto do vault |
| `ALEXANDRIA_NAMESPACE` | Proveniência do agente em novas notas |
| `ALEXANDRIA_INDEX_DB` | Caminho do índice SQLite local |
| `ALEXANDRIA_SETTINGS_PATH` | Configuração opcional de expansão de busca |
| `ALEXANDRIA_EXPANSION_CACHE` | Cache local de expansão de busca |

## Telemetria local

Use `--telemetry` durante a instalação para ativar logs JSONL locais com rotação e retenção limitada. Para registros MCP já existentes, defina `ALEXANDRIA_TELEMETRY=1` no ambiente do servidor e reconecte o cliente. Os logs não incluem argumentos, conteúdo das notas, resultados nem credenciais.

Execute `node alexandria-mcp/telemetry-summary.js` para consultar sucessos, erros, latência mediana e p95 por ferramenta e período. Um hook opcional do Codex observa tentativas pelo cliente separadamente. Timeouts e falhas de conexão do host ficam explicitamente indisponíveis quando não podem ser observados. Veja a [configuração e os limites da telemetria](docs/telemetry.md).

## Arquivos do projeto

- `alexandria-mcp/` — servidor MCP, kernel do vault, ponte HTTP e interface local.
- `install.js` — instalador multiplataforma para os clientes listados acima.
- `AI-PROMPT.md` — instruções de memória para agentes.
- `rules/alexandria.mdc` — regra always-on do Cursor.
- `INSTRUCTIONS-FOR-AI.md` — checklist para agentes que ajudam na instalação.

## Contribuições

Relatos de bugs, ideias e pull requests são bem-vindos. Leia [CONTRIBUTING.md](CONTRIBUTING.md) antes de abrir uma issue ou pull request.

## Autoria

Criado por **Neves e Nicolas Vlad**.
