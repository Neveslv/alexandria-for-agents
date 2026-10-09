# Installation instructions for AI agents

Alexandria for Agents provides persistent Markdown memory for AI coding agents through a local MCP server.

## Installation

1. Ask the user for the absolute path to their Obsidian vault if it has not been provided.
2. Ask which supported client to configure only when it is not clear. Supported automatic adapters: `codex`, `cursor`, `claude-code`, and `gemini-cli`. `all` configures the available adapters.
3. From the repository root, run:

   ```sh
   node install.js --vault "/absolute/path/to/vault" --client codex
   ```

   On Windows, quote the Windows absolute path, for example:

   ```powershell
   node .\install.js --vault "C:\Users\name\Alexandria" --client codex
   ```

4. Confirm the output reports server initialization and client configuration. Tell the user to restart/reload the selected AI client, start a new conversation, and ask it to run `vault_stats`.

## Requirements

- Node.js 18+
- `sqlite3` available on `PATH`
- The selected AI client installed separately

## Memory protocol

- Before substantive work, call `vault_recall` with 2–5 relevant terms.
- For complex or history-dependent work, use `vault_context`, `vault_search`, or `vault_read` to confirm details.
- After producing a response, plan, decision, diagnosis, result, or blockage, call `vault_auto_save` with a concise summary.
- Save durable reusable knowledge with `vault_write`, `overwrite: false`, and provenance.
- Store notes in root categories (`concepts`, `decisions`, `entities`, `patterns`, `plans`, `postmortems`, `projects`, `research`, `sessions`, `tools`). Keep agent identity in frontmatter, not in category subfolders.
- Never persist credentials, tokens, cookies, `.env` files, raw logs, or sensitive personal data.

If Alexandria is unavailable, continue only when safe and clearly tell the user that memory was not consulted or saved. Do not claim the client loaded the integration until `vault_stats` succeeds in a new client session.
