# Alexandria MCP server

This directory contains Alexandria's local MCP stdio server, vault kernel, optional HTTP interface, and web UI. The server stores Markdown notes in an Obsidian vault and maintains a local SQLite index for search.

For installation, supported AI clients, and the memory workflow, start with the repository [README](../README.md) and run `node install.js` from the repository root. The install script copies the MCP entry point and kernel into `~/.alexandria/mcp-server/` and registers the selected client.

## Available MCP tools

- `vault_recall`: quick retrieval from hot context and indexed notes.
- `vault_search`: search notes and semantic observations or relations.
- `vault_read`: read a note from a vault-relative path, title, or permalink.
- `vault_context`: build a context package from a query or linked note.
- `vault_write`: create or update a note in an allowed root category.
- `vault_auto_save`: write a dated session summary and update `hot.md`.
- `vault_list`, `vault_recent_activity`, and `vault_stats`: browse notes and inspect vault health.

## HTTP interface

The optional loopback HTTP service and UI use the same kernel. From this directory, set `ALEXANDRIA_VAULT_DIR` and run `node http/server.js`. The service binds only to loopback. See the repository root README for privacy and configuration guidance.

## Development

The MCP server uses Node.js built-ins and the `sqlite3` command-line program. It does not require API credentials for local text and semantic search. Remote query expansion remains disabled unless explicitly configured in the optional settings file.
