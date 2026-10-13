"""Synthetic MCP benchmark. Runtime files are always in a temporary directory."""
import argparse
import hashlib
import json
import math
import os
from pathlib import Path
import platform
import random
import statistics
import subprocess
import tempfile
import time
from mcp_client import MCP, RequestTimeout
from score import extract_paths, normalize, score, summarize

def digest(path):
    # Git checkouts can translate JSON fixtures between CRLF and LF by OS.
    # Hash the canonical LF representation so frozen datasets verify on both.
    content = Path(path).read_bytes().replace(b"\r\n", b"\n")
    return hashlib.sha256(content).hexdigest()

def load_dataset(directory, corpus_name=None):
    directory = Path(directory)
    manifest = json.loads((directory/"manifest.json").read_text(encoding="utf-8-sig"))
    for name, expected in manifest["sha256"].items():
        normalize(name)
        if digest(directory/name) != expected:
            raise ValueError("Frozen fixture hash mismatch: "+name)
    selected = corpus_name or manifest["corpus"]
    if selected not in manifest["sha256"]:
        raise ValueError("Corpus must be a frozen manifest member")
    corpus = json.loads((directory/selected).read_text(encoding="utf-8-sig"))
    queries = json.loads((directory/"queries.json").read_text(encoding="utf-8-sig"))
    paths = [normalize(d["path"]) for d in corpus]
    if len(paths) != len(set(paths)):
        raise ValueError("Duplicate corpus path")
    ids = [q["id"] for q in queries]
    if len(ids) != len(set(ids)):
        raise ValueError("Duplicate query id")
    for query in queries:
        if not set(query["relevant"]).issubset(paths):
            raise ValueError("Relevant path missing from corpus")
    manifest = {**manifest, "selected_corpus":selected}
    return corpus, queries, manifest

def resolve_server_root(server_root):
    root = Path(server_root).resolve()
    if root.name == "alexandria-mcp" and (root/"server.js").is_file():
        root = root.parent
    if not (root/"alexandria-mcp/server.js").is_file():
        raise ValueError("Missing Alexandria MCP server entrypoint")
    return root

def identity(server_root):
    server_root = Path(server_root).resolve()
    files = sorted((server_root/"alexandria-mcp").rglob("*.js"))
    files = [p for p in files if "node_modules" not in p.parts]
    try:
        sha = subprocess.check_output(["git","-C",str(server_root),"rev-parse","HEAD"],text=True,timeout=5).strip()
    except (OSError, subprocess.SubprocessError):
        sha = None
    return {"commit":sha, "source_sha256":{p.relative_to(server_root).as_posix():digest(p) for p in files},
            "python":platform.python_version(), "platform":platform.platform(),
            "node":subprocess.check_output(["node","--version"],text=True,timeout=5).strip()}

def populate(runtime, corpus):
    vault = runtime/"vault"
    vault.mkdir()
    for doc in corpus:
        p = vault/normalize(doc["path"])
        p.parent.mkdir(parents=True, exist_ok=True)
        front = {"title":doc["title"], "agent":"Benchmark", "category":doc["path"].split("/")[0],
                 "created":doc.get("created","2026-10-01T00:00:00Z"),
                 "modified":doc.get("modified","2026-10-01T00:00:00Z"),
                 "status":doc.get("status","current"), "kind":doc.get("kind","fact"),
                 "entities":doc.get("entities",[])}
        text = "---\n" + "\n".join(f"{k}: {json.dumps(v,ensure_ascii=False)}" for k,v in front.items())
        p.write_text(text+"\n---\n\n"+doc["body"],encoding="utf-8")
        stamp = doc.get("mtime",1790812800)
        os.utime(p,(stamp,stamp))
    (runtime/"settings.json").write_text('{"allowRemoteExpansion":false}',encoding="utf-8")

def run(server_root, dataset, output, reps=3, timeout=30, corpus_name=None, explain=False):
    if reps < 1 or timeout <= 0:
        raise ValueError("Positive reps and timeout required")
    server_root = resolve_server_root(server_root)
    corpus, queries, manifest = load_dataset(dataset, corpus_name)
    output = Path(output).resolve()
    if (output/"results.json").exists():
        raise ValueError("Output already contains a measurement; choose a fresh directory")
    output.mkdir(parents=True, exist_ok=True)
    report = {"schema_version":1,"identity":identity(server_root),"dataset":manifest,
              "reps":reps,"seed":7301,"rows":[],"status":"ok"}
    with tempfile.TemporaryDirectory(prefix="alexandria-retrieval-") as tmp:
        runtime = Path(tmp)
        populate(runtime,corpus)
        env = os.environ.copy()
        env.update({"ALEXANDRIA_VAULT_DIR":str(runtime/"vault"),
                    "ALEXANDRIA_INDEX_DB":str(runtime/"index.db"),
                    "ALEXANDRIA_SETTINGS_PATH":str(runtime/"settings.json"),
                    "ALEXANDRIA_EXPANSION_CACHE":str(runtime/"expansions.json"),
                    "ALEXANDRIA_TELEMETRY":"0","ALEXANDRIA_NAMESPACE":"Benchmark",
                    "HOME":str(runtime),"USERPROFILE":str(runtime),
                    "XDG_CACHE_HOME":str(runtime/"cache"),"HF_HOME":str(runtime/"models"),
                    "TRANSFORMERS_CACHE":str(runtime/"models"),"HF_HUB_OFFLINE":"1",
                    "TRANSFORMERS_OFFLINE":"1"})
        allowed_flags = ("ALEXANDRIA_RETRIEVAL_RRF", "ALEXANDRIA_RETRIEVAL_AUTHORITY", "ALEXANDRIA_EMBEDDING_MODE", "ALEXANDRIA_ABSTENTION", "ALEXANDRIA_MODEL_ID", "ALEXANDRIA_MODEL_REVISION", "ALEXANDRIA_MODEL_DIMENSION")
        report["flags"] = {k:env[k] for k in allowed_flags if k in env}
        log_path = runtime/"server.log"
        client = MCP(["node",str(Path(server_root).resolve()/"alexandria-mcp/server.js")], env, log_path)
        try:
            _, report["handshake_ms"] = client.initialize(timeout)
            listing, report["tools_list_ms"] = client.call("tools/list",{},timeout)
            if "vault_search" not in {t["name"] for t in listing["result"]["tools"]}:
                raise RuntimeError("vault_search unavailable")
            cold, report["cold_first_query_ms"] = client.call("tools/call",
                {"name":"vault_search","arguments":{"query":queries[0]["query"],"limit":5,"include_snippets":False,"explain":explain}},timeout)
            report["cold_first_query_raw"] = cold
            report["warmup_latencies_ms"] = []
            for query in queries:
                _, ms = client.call("tools/call",{"name":"vault_search",
                    "arguments":{"query":query["query"],"limit":5,"include_snippets":False,"explain":explain}},timeout)
                report["warmup_latencies_ms"].append(ms)
            for rep in range(reps):
                ordered = list(queries)
                random.Random(7301+rep).shuffle(ordered)
                for query in ordered:
                    row = {**query, "repeat":rep}
                    started = time.monotonic()
                    try:
                        reply, ms = client.call("tools/call",{"name":"vault_search","arguments":{"query":query["query"],"limit":5,"include_snippets":False,"explain":explain}},timeout)
                        raw = {"text":"\n".join(b.get("text","") for b in reply["result"].get("content",[]))}
                        paths = extract_paths(raw)
                        row.update(status="ok",latency_ms=ms,paths=paths)
                        if rep == 0:
                            row.update(raw=reply,metrics=score(query,paths))
                    except Exception as error:
                        row.update(status="timeout" if isinstance(error,RequestTimeout) else "error",
                                   latency_ms=(time.monotonic()-started)*1000,error_type=type(error).__name__)
                        report["status"] = "failed"
                    report["rows"].append(row)
                    if client.closed or client.process.poll() is not None:
                        raise RuntimeError("MCP process unavailable; remaining queries not measured")
        except Exception as error:
            report.update(status="failed",error_type=type(error).__name__)
        finally:
            client.close()
            # Only synthetic server stderr is retained.
            (output/"server.log").write_bytes(log_path.read_bytes())
    xs = [r["latency_ms"] for r in report["rows"] if r["status"] == "ok"]
    report["latency"] = {"requests":len(xs),"failed":sum(r["status"] != "ok" for r in report["rows"]),
                         "median_ms":statistics.median(xs) if xs else None,
                         "p95_ms":sorted(xs)[math.ceil(.95*len(xs))-1] if xs else None}
    report["quality"] = summarize(report["rows"])
    report["expected_requests"] = reps*len(queries)
    report["unmeasured_requests"] = report["expected_requests"]-len(report["rows"])
    (output/"results.json").write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding="utf-8")
    return report

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--server-root",type=Path,required=True,help="Checkout containing alexandria-mcp/server.js")
    parser.add_argument("--dataset",type=Path,required=True,help="Frozen fixture directory")
    parser.add_argument("--output",type=Path,required=True,help="Synthetic results and stderr directory")
    parser.add_argument("--explain",action="store_true",help="Return synthetic ranking evidence for calibration")
    parser.add_argument("--corpus",help="Select a corpus filename already hashed in the manifest (original: corpus-120.json or corpus-600.json)")
    parser.add_argument("--reps",type=int,default=3)
    parser.add_argument("--timeout",type=float,default=30,help="Bound per MCP request, seconds")
    args = parser.parse_args()
    result = run(args.server_root,args.dataset,args.output,args.reps,args.timeout,args.corpus,args.explain)
    print(json.dumps({k:result[k] for k in ("status","latency","quality")},ensure_ascii=False))
    return int(result["status"] != "ok")

if __name__ == "__main__":
    raise SystemExit(main())
