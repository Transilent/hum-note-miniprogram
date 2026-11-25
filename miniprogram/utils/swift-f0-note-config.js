// Fixed on development singers; see docs/2026-11-03-SwiftF0识别优化.md.
module.exports = {
  id: 'humming-notes-v2', gapBias: -.35,
  transition: { jump: 1, spread: .25, penalty: 3 },
  repeat: { depthDb: 6, confidenceDrop: .08, minimumFrames: 6 },
  onsets: { id: 'humming-notes-v3', flux: .30, depth: 2, minFrames: 6 },
  shortNotes: { minimumBeats: .0625, minimumConfidence: .85, maximumDeviation: .4 }
};
