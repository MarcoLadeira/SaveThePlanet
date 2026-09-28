// Target pinning for the shared historical forecast (Dashboard, Charging, Impact, Volt).
// The pinned target only changes when a *real, fresh* forecast arrives. A stale forecast
// (model unreachable; last real result for the pinned target) or an offline example must
// never move it, so every page and Volt keep asking about the same half-hour and nothing
// silently jumps when the model recovers.
function pinnedTargetAfter(current, body) {
  if (!body || body.dataMode === 'simulated' || body.stale) return current;
  return body.pinnedTarget || current;
}

// Short labels for how the pinned half-hour was selected (see backend/targets.py).
function selectionChip(selection) {
  if (!selection) return null;
  if (selection.mode === 'unfiltered') return { tone: 'neutral', text: 'Unfiltered random half-hour' };
  if (selection.mode === 'pinned') return { tone: 'neutral', text: 'Chosen earlier' };
  if (selection.metThreshold) return { tone: 'ok', text: `Predicted ≥ ${selection.minPredictedMwh} MWh · chosen from predictions` };
  return { tone: 'warn', text: `Below ${selection.minPredictedMwh} MWh threshold · best of ${selection.attempts} tried` };
}

if (typeof module !== 'undefined') module.exports = { pinnedTargetAfter, selectionChip };
