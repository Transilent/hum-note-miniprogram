// Ignore save timestamps: opening a page can flush an unchanged edit, while the
// source notes and BPM still describe exactly the same creative starting point.
function sourceFingerprint(idea) {
  return JSON.stringify([idea.id, idea.bpm, idea.notes.map(n => [n.midi, n.start, n.duration, n.velocity || 85, Number.isFinite(n.confidence) ? n.confidence : 1])]);
}
module.exports = { sourceFingerprint };
