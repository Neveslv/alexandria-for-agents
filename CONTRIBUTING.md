# Contributing to Alexandria for Agents

Thank you for helping improve Alexandria. Contributions from the community are welcome, including bug reports, documentation fixes, compatibility improvements, and focused code changes.

## Before you start

- Search existing issues and pull requests to avoid duplicating work.
- For a large change or a new feature, open an issue first so the maintainers can discuss scope and compatibility.
- For a small, clear fix, you can open a pull request directly.
- Never include an Obsidian vault, SQLite index/database, personal notes, credentials, tokens, cookies, `.env` files, or raw logs in an issue or pull request.

## Contribution workflow

1. Fork `Neveslv/alexandria-for-agents` and clone your fork.
2. Create a focused branch from `main`, for example `fix/installer-path-handling` or `docs/client-setup`.
3. Make the smallest coherent change that addresses the issue.
4. Review your diff for unrelated edits, generated files, and sensitive data.
5. Run the relevant checks listed below and report their results in the pull request.
6. Open a pull request against `Neveslv/alexandria-for-agents:main`. Explain the problem, the change, and any behavior or compatibility impact. Link the related issue when applicable.

External contributors should work from a fork; direct write access to the main repository is not required.

## Development checks

Run the dependency-free telemetry and protocol tests with `node --test tests/*.test.js` (Node.js 18 or later). For JavaScript changes, also run syntax checks for the files you changed. For example:

```bash
node --check install.js
node --check alexandria-mcp/server.js
node --check alexandria-mcp/lib/kernel.js
```

If you change the HTTP server or app, also check the relevant files under `alexandria-mcp/http/`. If you change shell scripts, run `bash -n setup.sh` on a system with Bash. Include any manual validation steps and clearly state checks you could not run.

Do not run the installer against a real vault unless you intend to modify it. Prefer `--dry-run` for installer previews.

## Code and documentation expectations

- Keep changes focused and preserve existing behavior unless the issue calls for a behavior change.
- Prefer Node.js built-ins over new dependencies; explain new runtime or install dependencies in the pull request.
- Keep user data local and follow the privacy guidance in the README.
- Update English and Brazilian Portuguese documentation when a user-facing change affects both.
- Do not commit generated indexes, vault contents, local settings, or secrets.
- Use clear commit messages; a conventional format such as `fix: preserve existing MCP configuration` is welcome.

## Pull request checklist

- [ ] The change is focused and linked to an issue when appropriate.
- [ ] I reviewed the diff and removed unrelated or sensitive files.
- [ ] I ran the relevant checks and listed their results.
- [ ] I updated documentation in both languages when needed.
- [ ] I described compatibility or migration implications.
