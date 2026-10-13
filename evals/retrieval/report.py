"""Reproduce baseline quality solely from frozen synthetic first-pass responses."""
import argparse
import json
from pathlib import Path
from score import extract_paths, summarize

def verify_preserved(directory):
    files = sorted((Path(directory)/"baselines").glob("results-*.json"))
    if len(files) != 7:
        raise ValueError("Expected seven preserved files")
    max_delta = 0
    details = []
    for path in files:
        data = json.loads(path.read_text(encoding="utf-8"))
        rows = []
        for original in data["rows"]:
            if original["repeat"] != 0:
                continue
            row = dict(original)
            row["paths"] = extract_paths(row["raw"])
            rows.append(row)
        quality = summarize(rows)
        for group, expected in data["summary"]["quality"].items():
            for key, value in expected.items():
                delta = abs(quality[group][key]-value)
                max_delta = max(max_delta,delta)
                if delta > 1e-12:
                    raise AssertionError(f"{path.name}: {group}/{key} delta={delta}")
        details.append({"file":path.name,"quality":quality})
    return {"files":len(files),"max_delta":max_delta,"details":details}

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("directory",type=Path)
    args = parser.parse_args()
    print(json.dumps(verify_preserved(args.directory),ensure_ascii=False,indent=2))
