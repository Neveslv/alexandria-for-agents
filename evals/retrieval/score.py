"""Deterministic header-only scoring of synthetic retrieval responses."""
import math
import re
import statistics

def normalize(path):
    path = path.replace("\\", "/")
    if path.startswith("/") or ":" in path or any(x in ("", ".", "..") for x in path.split("/")):
        raise ValueError("Expected relative normalized path")
    return path

def extract_paths(raw):
    if "hits" in raw:
        return [normalize(h["path"]) for h in raw["hits"]]
    text = raw.get("text", "")
    return [normalize(p) for p in re.findall(r"^\d+\. \*\*[^\r\n]*\*\* \[note:[^\]\r\n]+\] — \x60([^\x60\r\n]+\.md)\x60(?=\r?$)", text, re.M)]

def score(query, paths, k=5):
    if k < 1:
        raise ValueError("k must be positive")
    relevant = set(normalize(p) for p in query["relevant"])
    # Duplicates occupy their original rank but never gain relevance twice.
    seen = set()
    gains = []
    for p in paths[:k]:
        p = normalize(p)
        gains.append(int(p in relevant and p not in seen))
        seen.add(p)
    if not relevant:
        return {"correct_abstention": float(not paths)}
    ideal = sum(1 / math.log2(i + 2) for i in range(min(k, len(relevant))))
    return {f"hit_at_{k}": float(any(gains)),
            f"recall_at_{k}": sum(gains) / len(relevant),
            f"mrr_at_{k}": next((1 / (i + 1) for i, gain in enumerate(gains) if gain), 0),
            f"ndcg_at_{k}": sum(g / math.log2(i + 2) for i, g in enumerate(gains)) / ideal}

def summarize(rows, k=5):
    first = [r for r in rows if r["repeat"] == 0]
    groups = ["all_positive"] + sorted({r["group"] for r in first})
    output = {}
    for group in groups:
        selected = [r for r in first if (bool(r["relevant"]) if group == "all_positive" else r["group"] == group)]
        success = [r for r in selected if r.get("status", "ok") == "ok"]
        scores = [score(r, r["paths"], k) for r in success]
        keys = sorted({key for s in scores for key in s})
        output[group] = {"queries": len(selected), "scored": len(success),
                         "errors": len(selected) - len(success),
                         **{key: statistics.mean(s[key] for s in scores if key in s) for key in keys}}
    return output
