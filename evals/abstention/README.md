# Experimental calibrated abstention

The calibration is frozen for the selected trained + authority configuration
identified in `calibration.json`. It was derived only from the independent
`development` fixture and its saved `--explain` evidence. Neither original nor
holdout labels select the threshold. The calibrator refuses those datasets and
refuses overwriting a frozen output.

```powershell
python evals/abstention/calibrate.py --development-evidence <development-results.json> --output <new-calibration.json>
```

The feature is the maximum finite **raw lexical FTS score** across candidates.
The threshold is the weakest development positive's maximum lexical score,
stepped one floating point ULP toward zero. Scores from RRF, authority multipliers,
and vector similarities are never interpreted as probabilities. Vector similarity
alone did not separate development positives from negatives.

The decision empties the whole result or retains every candidate: it never removes
individual evidence from a multi-note answer. Empty results abstain. A missing or
invalid calibration, mismatched configuration/model/search mode, or unavailable
evidence disables calibrated suppression and returns an explicit reason code.
A candidate with valid vector-only evidence has zero lexical evidence and can be
suppressed by this experimental lexical gate.

This rule can suppress semantic-only paraphrases. Development retained 14/14
positive queries and abstained on 4/4 negative queries; those measurements are not
the original/holdout acceptance gates. Keep `ALEXANDRIA_ABSTENTION=0` unless the
unchanged frozen rule passes the original and holdout gates with no positive or
multi-note regression. Set `ALEXANDRIA_ABSTENTION_CALIBRATION` to an explicit
absolute calibration path when testing the opt-in flag. No automatic download or
calibration occurs during a tool call.

Acceptance evaluation rejected this frozen experiment: all4 negatives were empty in original and holdout, but2 original positives and1 holdout positive were suppressed. Keep the supplied calibration disabled; it is not an approved relevance improvement. No retuning followed evaluation.
