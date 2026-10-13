# Retrieval evaluation (T01)

Requires Python 3.10+ standard library and Node 24. No packages or model downloads.
--server-root accepts either the checkout root or its alexandria-mcp directory.
--corpus selects an already hashed corpus (for example corpus-120.json);
labels/manifests are never rewritten by the runner.
The benchmark launches the actual Alexandria stdio MCP server; it does not call
retrieval internals. Every execution creates a temporary synthetic vault, index,
settings, cache, model-home and stderr log. It never uses the canonical vault or
changes client registration. Ambient Alexandria feature flags are inherited; only four known retrieval flag
values are recorded, never arbitrary environment values; use the same explicit flags when comparing runs.

Run from the repository root:

    node --test tests/retrieval-evals.test.js
    python -B evals/retrieval/benchmark.py --server-root . --dataset evals/retrieval/fixtures/development --output .task-data/dev-baseline --reps 3 --timeout 30
    python -B evals/retrieval/report.py evals/retrieval/fixtures/original

Use distinct output directories for each server/configuration/dataset.
The output contains results.json and synthetic server.log. Results include source
file SHA-256 (including dirty source), Git SHA, runtime/platform identity, corpus
and label hashes, active flags, repeat order, every observed request latency and
the complete synthetic MCP reply for the first repetition. The first retrieval is cold and retained separately with its full raw reply.
One explicit full-query warmup runs before all measured repetitions; warmup
latencies are retained separately and excluded from warm median/p95. Success latency
statistics exclude failures; failure latencies remain in rows. Failed or unmeasured
requests and scoring coverage are explicit; failed runs exit nonzero. Do not
promote a partially scored run. Handshake and tools/list are separately timed.

MCP requests have a deadline for both stdin writes and response reads. A timeout
terminates the child; cleanup escalates to kill after one second. Notifications
are skipped, non-JSON stdout/EOF/remote errors fail, stderr goes directly to a
file to prevent pipe-pressure deadlocks. The driver performs sequential requests.

## Frozen fixtures

- original: preserved 120/600-note corpora, 44 queries, original source identity
  and all seven raw result files from work/benchmark-ai-memory. Default corpus
  is corpus-600.json. The baseline reproduction uses existing first-pass raw
  responses only; it does not rerun old binaries.
- development: 30 independent synthetic notes, 18 PT/EN queries. Calibrate here.
- holdout: 30 independent synthetic notes, 18 PT/EN queries. Final gate only:
  freeze labels before candidate runs; do not tune parameters after inspecting
  holdout. It has different topics/entities from development and original.
- Both independent sets contain two multi-note queries, four absent queries,
  current decisions and historical superseded notes, with fixed mtimes.

Each manifest hashes corpus, queries and preserved baseline inputs. Loading
checks every hash and label path. A mismatch aborts before launching the server.
Manifests are reproducibility guards, not cryptographic protection against an
operator deliberately rewriting both labels and hashes. Record the manifest's
own hash outside the checkout before gate execution.

Scoring requires the exact formatter header structure, including bold title,
note category and em-dash separator before the path (or structured hits).
Inline code paths in titles and numbered snippet lines cannot count as hits.
The harness requests include_snippets:false for cold, warmup and measured
queries, while preserving the full synthetic raw MCP response. Top-k duplicates occupy rank but receive no additional relevance
gain. Hit, recall, reciprocal rank and binary NDCG are deterministic. Negative
queries receive correct_abstention only and are excluded from positive means.
Quality is scored only on repeat zero. Error rows are not silently mapped to
empty successful results; summaries expose queries/scored/errors separately.

These corpora are original synthetic Codex content, not copied upstream
ai-memory source; no third-party source/runtime/model is bundled. Original
provenance/SHA is preserved in original/source-manifest.json. Historical fixtures
are static current-versus-old notes, not a mutation/watcher integration test.
T08/T09/T11 own real comparative measurements and promotion decisions.
