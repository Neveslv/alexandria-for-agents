# Alexandria for Agents

[English](README.md) | [Português (Brasil)](README.pt-BR.md)

Persistent, local-first memory for AI agents, stored as Markdown in an Obsidian vault and accessed through MCP tools. Alexandria carries useful context from one session into the next: an agent recalls relevant notes before working and saves a concise summary afterward.

## What it does

- Reads and writes Markdown notes in your local vault.
- Indexes the vault in SQLite for local full-text and semantic search.
- Provides MCP tools including `vault_recall`, `vault_search`, `vault_read`, `vault_context`, `vault_write`, `vault_auto_save`, and `vault_stats`.
- Installs the server and, for supported clients, registers the MCP server and adds persistent instructions so the agent uses Alexandria automatically.
- Includes a local HTTP API and an optional web interface for searching and browsing the vault.

Markdown files remain readable and editable in Obsidian. The SQLite index is auxiliary and can be rebuilt from the notes. Installation is local; the default search does not require an API key.

## Requirements

- Node.js 18 or later
- SQLite 3 (`sqlite3`) available on `PATH`
- An existing Obsidian vault, or a directory you want to initialize
- For automatic integration: Codex CLI, Cursor, Claude Code, or Gemini CLI

Install the AI clients separately.

## Installation

Clone the repository and run the installer with the absolute path to your vault and the client to configure.

### Windows PowerShell

```powershell
git clone https://github.com/Neveslv/alexandria-for-agents.git
cd alexandria-for-agents
node .\install.js --vault "C:\Users\your-user\Alexandria" --client codex
```

### macOS or Linux

```bash
git clone https://github.com/Neveslv/alexandria-for-agents.git
cd alexandria-for-agents
node install.js --vault "$HOME/Documents/Alexandria" --client codex
```

Supported client values: `codex`, `cursor`, `claude-code`, `gemini-cli`, or `all`. The `all` option configures every supported client that is available; install each client before running the installer. To see all options, run `node install.js --help`.

The installer copies the server to `~/.alexandria/mcp-server/`, initializes the vault and its index, and configures the selected client. It preserves other entries in JSON configuration files and creates backups before changing files. If Codex or Claude Code already has an MCP server named Alexandria, the existing entry is left unchanged. Preview the installation with `--dry-run`.

| Client | MCP registration | Persistent instructions |
| --- | --- | --- |
| Codex | `codex mcp add` | `~/.codex/AGENTS.md` |
| Cursor | `~/.cursor/mcp.json` | `~/.cursor/rules/alexandria.mdc` |
| Claude Code | `claude mcp add --scope user` | `~/.claude/CLAUDE.md` |
| Gemini CLI | `~/.gemini/settings.json` | `~/.gemini/GEMINI.md` |

The installed instructions tell the agent to consult memory before work and save a summary afterward. The installer only adds or updates the Alexandria block in existing instruction files.

## How to use

1. Restart or reload the selected client, then open a new conversation.
2. Ask the agent to run `vault_stats` and confirm that the server is connected.
3. Work normally. The installed instructions guide the agent to call `vault_recall` before responding and `vault_auto_save` at the end.
4. To save knowledge for future retrieval, use `vault_write` with `overwrite: false`.
5. Open the same folder you gave the installer in Obsidian to view and edit your notes.

For another MCP-compatible client, configure the local server manually:

```json
{
  "mcpServers": {
    "alexandria": {
      "command": "node",
      "args": ["/path/to/.alexandria/mcp-server/server.js"],
      "env": {
        "ALEXANDRIA_VAULT_DIR": "/absolute/path/to/vault",
        "ALEXANDRIA_NAMESPACE": "Agent name",
        "ALEXANDRIA_INDEX_DB": "/path/to/.alexandria/vault-index.db"
      }
    }
  }
}
```

Configuration file formats and locations vary by client. Clients without a built-in installer adapter also need `AI-PROMPT.md` added to their persistent instructions to use the memory workflow automatically.

## Configuration and privacy

The installer does not request credentials. The server reads and writes only under the path passed to `--vault`. Do not save secrets, tokens, cookies, `.env` files, raw logs, or sensitive personal data in your notes. Remote LLM-based search expansion is disabled by default.

Server environment variables:

| Variable | Purpose |
| --- | --- |
| `ALEXANDRIA_VAULT_DIR` | Absolute path to the vault |
| `ALEXANDRIA_NAMESPACE` | Agent provenance for new notes |
| `ALEXANDRIA_INDEX_DB` | Path to the local SQLite index |
| `ALEXANDRIA_SETTINGS_PATH` | Optional search-expansion settings |
| `ALEXANDRIA_EXPANSION_CACHE` | Local search-expansion cache |

## Local telemetry

Use `--telemetry` during installation to opt in to local JSONL logs with rotation and limited retention. For existing registrations, set `ALEXANDRIA_TELEMETRY=1` in the MCP server environment and reconnect the client. Logs exclude arguments, note content, results, and credentials.

Run `node alexandria-mcp/telemetry-summary.js` to view successes, errors, median latency, and p95 by tool and period. An optional Codex hook observes client attempts separately. Host timeouts and connection failures remain explicitly unavailable when not observable. See [telemetry setup and limits](docs/telemetry.md).

## Project files

- `alexandria-mcp/` — MCP server, vault kernel, HTTP bridge, and local interface.
- `install.js` — cross-platform installer for the clients listed above.
- `AI-PROMPT.md` — memory instructions for agents.
- `rules/alexandria.mdc` — always-on Cursor rule.
- `INSTRUCTIONS-FOR-AI.md` — checklist for agents assisting with installation.

## Contributing

Bug reports, ideas, and pull requests are welcome. Please read [CONTRIBUTING.md](CONTRIBUTING.md) before opening an issue or pull request.

## Authors

Created by **Neves and Nicolas Vlad**.
