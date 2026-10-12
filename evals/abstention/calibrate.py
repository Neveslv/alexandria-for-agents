"""Freeze an experimental lexical gate using development evidence only."""
import argparse
import hashlib
import json
import math
from pathlib import Path


def calibrate(report):
    dataset = report.get('dataset', {})
    if dataset.get('name') != 'development' or dataset.get('calibration_allowed') is not True:
        raise ValueError('Only frozen development evidence is allowed')
    if dataset.get('frozen_before_candidate_measurements') is not True:
        raise ValueError('Development fixtures must be frozen')
    if report.get('status') != 'ok':
        raise ValueError('Unsuccessful benchmark cannot calibrate')
    rows = [r for r in report['rows'] if r['repeat'] == 0]
    identities, positive_scores, negative_scores = set(), [], []
    for row in rows:
        if row.get('status') != 'ok':
            raise ValueError('Failed query cannot calibrate')
        text = '\n'.join(c.get('text', '') for c in row['raw']['result']['content'])
        marker = 'Ranking evidence: '
        if marker not in text:
            raise ValueError('Explain evidence is required')
        evidence = json.loads(text.split(marker, 1)[1])
        retrieval = evidence['retrieval']
        if retrieval.get('fallback') or retrieval.get('mode') != 'trained':
            raise ValueError('Calibrate only the frozen trained configuration')
        config_identity = retrieval.get('configIdentity')
        if not isinstance(config_identity, str) or not config_identity.strip():
            raise ValueError('Nonempty configuration identity required')
        identities.add(config_identity)
        scores = [e['rawScore'] for hit in evidence['items'] for e in hit.get('evidence', [])
                  if e.get('stream') == 'fts' and isinstance(e.get('rawScore'), (int, float))
                  and not isinstance(e['rawScore'], bool) and math.isfinite(e['rawScore'])]
        maximum = max([0] + scores)
        (positive_scores if row['relevant'] else negative_scores).append(maximum)
    if len(identities) != 1 or not positive_scores or min(positive_scores) <= 0:
        raise ValueError('Need one configuration and positive lexical evidence for every positive')
    # Largest observed floor retaining every development positive, stepped down
    # one ULP. Negative labels never select or adjust this threshold.
    threshold = math.nextafter(min(positive_scores), 0)
    return {'schemaVersion': 1, 'configIdentity': identities.pop(),
            'feature': 'max_lexical_raw_score', 'threshold': threshold,
            'method': 'minimum development positive maximum lexical score, one ULP margin',
            'dataset': {'name': 'development', 'sha256': dataset['sha256']},
            'development': {'positive_queries': len(positive_scores),
                            'positive_queries_retained': sum(s >= threshold for s in positive_scores),
                            'negative_queries': len(negative_scores),
                            'negative_queries_abstained': sum(s < threshold for s in negative_scores)},
            'experimental': True,
            'limitations': 'Vector evidence overlaps negatives; semantic-only paraphrases can be suppressed. Original and holdout gates must be evaluated without threshold changes.'}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--development-evidence', required=True, type=Path)
    parser.add_argument('--output', required=True, type=Path)
    args = parser.parse_args()
    if args.output.exists():
        raise ValueError('Refuse to overwrite a frozen calibration')
    data = args.development_evidence.read_bytes()
    calibration = calibrate(json.loads(data.decode('utf-8-sig')))
    calibration['evidence_sha256'] = hashlib.sha256(data).hexdigest()
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(calibration, indent=2) + '\n', encoding='utf-8')

if __name__ == '__main__':
    main()
