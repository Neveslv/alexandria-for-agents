# Local MCP telemetry

Telemetry is opt-in, local, and best effort. It never writes to the vault, sends data over the network, or emits log records on MCP stdout.

## Enable collection

For a new MCP registration, add `--telemetry` to the installer:

```bash
node install.js --vault /absolute/path/to/vault --client codex --telemetry
```

For an existing registration, set `ALEXANDRIA_TELEMETRY=1` in the MCP server environment and reconnect/restart the client. Codex and Claude Code entries already registered under `alexandria` are preserved by the installer, so their environment must be updated manually. Use `ALEXANDRIA_TELEMETRY=0` to disable recording.

The installer copies the telemetry modules, summary command, and optional Codex hook alongside the server. Running the source checkout does not modify a previously installed server.

| Variable | Default | Meaning |
| --- | --- | --- |
| `ALEXANDRIA_TELEMETRY` | off | `1` enables recording; any other value disables it |
| `ALEXANDRIA_TELEMETRY_DIR` | `~/.alexandria/telemetry` | Directory outside the vault for JSONL files |
| `ALEXANDRIA_TELEMETRY_MAX_BYTES` | 1048576 | Maximum bytes per file (1024–104857600) |
| `ALEXANDRIA_TELEMETRY_MAX_FILES` | 10 | Maximum retained log files (1–1000) |
| `ALEXANDRIA_TELEMETRY_RETENTION_DAYS` | 7 | Maximum age of inactive log files (1–365 days) |

Logs rotate before reaching the size limit. Retention is applied when new events are written; without writes, expired files remain until the next write or manual removal. Multiple processes share the retention budget. Random per-process filenames avoid concurrent server writes to the same file. Client hooks share a separate append file and use a short-lived lock; simultaneous hooks may drop records rather than delay tools. Remove `.client-write-lock` if a killed hook leaves a stale lock behind. Read failures and malformed/truncated lines are tolerated in summaries. Logging errors do not change the tool response. File modes request private permissions on POSIX; Windows uses the directory's existing ACLs.

## Events and metrics

Records contain only schema version, timestamp, server version, an allowed tool name, event type, outcome, error category, and optional duration. Arguments, note text, results, exception messages, request IDs, and user/session identifiers are never serialized. Unknown tool names become `unknown`.

Server events cover startup success/failure, tool discovery, received tool calls, completed tool calls, observed stdio errors, malformed requests, and normal/signal-driven shutdown. Abrupt process termination, machine failure, or an unwritable log directory can prevent recording.

The summary provides completed received calls, successes, errors, success rate, median latency, p95 latency, and breakdown by tool. Success means a returned result without MCP `isError` or a JSON-RPC error, not proof that a response reached the client. Validation failures now return `isError: true`; an empty search is still a successful query. `observed_arrivals` counts arrival events separately, including arrivals with no completed event. Filtering and retention can include only one half of a call, so differences are not a precise timeout count. Latency measures server dispatch, including arrival logging, and excludes host/network round trips. p95 uses nearest rank; median averages the middle samples.

```bash
node alexandria-mcp/telemetry-summary.js --since 2026-10-01T00:00:00Z --until 2026-10-31T23:59:59Z
node alexandria-mcp/telemetry-summary.js --dir /path/to/logs
```

For an installed server, run `node ~/.alexandria/mcp-server/telemetry-summary.js`. Use quoted absolute paths on Windows. Omitted dates mean all retained events. A nonexistent directory produces an empty summary, not proof of no historical activity. The command reads files without writing events or notes.

## Optional Codex client observation

Official Codex hooks support `PreToolUse` and `PostToolUse` for MCP calls. Merge these entries into your existing hooks configuration; use the absolute installed script path and review/trust the hook as required by your Codex version. The installer does not overwrite global hooks. See [official hook documentation](https://learn.chatgpt.com/docs/hooks).

```json
{
  "hooks": {
    "PreToolUse": [{
      "matcher": "^mcp__alexandria__vault_.*$",
      "hooks": [{"type": "command", "command": "node /absolute/path/to/.alexandria/mcp-server/telemetry-hook.js --enabled"}]
    }],
    "PostToolUse": [{
      "matcher": "^mcp__alexandria__vault_.*$",
      "hooks": [{"type": "command", "command": "node /absolute/path/to/.alexandria/mcp-server/telemetry-hook.js --enabled"}]
    }]
  }
}
```

Quote the executable/script paths if they contain spaces, and escape Windows backslashes in JSON. Both hooks need the same telemetry directory and retention environment if you override the defaults. Remove `--enabled` (and disable `ALEXANDRIA_TELEMETRY`) or remove the hook entries to stop client collection.

This adapter records observed attempts and known returned MCP success/tool errors separately from server metrics. Unrecognized host results remain `unknown`. A missing callback is not classified as a timeout. Hooks may be disabled or unsupported by a host/version; MCP initialization/discovery failures before tool execution, host connection errors, and host timeouts are not fully exposed by these hooks. `client_timeouts` remains `null` rather than implying zero. Client hooks were tested with controlled payloads, not enabled in a live Codex session by this change.

## Validation and rollout

Run `node --test tests/*.test.js` from the repository root. Tests cover safe fields, disabled collection, unwritable logs, rotation/retention, date filtering, invalid JSON, tool exceptions and MCP error results, process startup failures, simulated broken stdout pipes, and the client hook adapter. Process tests isolate the transport from the vault with a controlled kernel; they do not certify SQLite or an existing vault.

Start with an isolated test vault, enable recording, reconnect, run `vault_stats`, and request a controlled validation error (such as `vault_write` without a title). Review the summary before enabling it for your main vault. No timeout or end-to-end availability rate is inferred from server-only data.
