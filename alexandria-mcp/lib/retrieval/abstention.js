'use strict';
// A calibrated corpus/configuration-specific lexical gate, not a probability.
function decideAbstention({hits,configIdentity},calibration) {
  if (!Array.isArray(hits)) return {abstain:false,reasonCode:'evidence_unavailable'};
  if (!hits.length) return {abstain:true,reasonCode:'empty_input'};
  if (!calibration) return {abstain:false,reasonCode:'calibration_unavailable'};
  if (typeof configIdentity !== 'string' || !configIdentity.trim() || typeof calibration.configIdentity !== 'string' || !calibration.configIdentity.trim()) return {abstain:false,reasonCode:'calibration_config_missing'};
  if (calibration.configIdentity !== configIdentity) return {abstain:false,reasonCode:'calibration_config_mismatch'};
  if (calibration.schemaVersion !== 1 || calibration.feature !== 'max_lexical_raw_score' ||
      !Number.isFinite(calibration.threshold) || calibration.threshold < 0) {
    return {abstain:false,reasonCode:'calibration_invalid'};
  }
  let observed = false, maximum = 0;
  for (const hit of hits) {
    if (!Array.isArray(hit.evidence)) continue;
    observed = true;
    for (const e of hit.evidence) {
      if (e && e.stream === 'fts' && Number.isFinite(e.rawScore)) maximum = Math.max(maximum,e.rawScore);
    }
  }
  if (!observed) return {abstain:false,reasonCode:'evidence_unavailable'};
  return maximum < calibration.threshold
    ? {abstain:true,reasonCode:'below_calibrated_lexical_evidence'}
    : {abstain:false,reasonCode:'calibrated_evidence_present'};
}
module.exports = {decideAbstention};
