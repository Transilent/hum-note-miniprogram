// Selected on valid_clean; no labels or dataset files are read at runtime.
module.exports = {
  "id": "humtrans-valid-selected-v1",
  "minFrequency": 40,
  "maxFrequency": 1400,
  "rmsFloor": 0.002,
  "relativeRmsGate": 0.035,
  "segmentation": {
    "medianWindow": 5,
    "confidenceThreshold": 0.3,
    "minActiveRms": 0.001,
    "hysteresisSemitones": 0.75,
    "stableFrames": 4,
    "bridgeFrames": 3,
    "bridgeMaxSeconds": 0.05,
    "bridgeRmsRatio": 0.12,
    "minNoteBeats": 0.125,
    "shortFragmentPolicy": "drop",
    "splitRepeatedNotes": true,
    "repeatMinNoteBeats": 0.25,
    "repeatValleyRatio": 0.5,
    "repeatRecoveryRatio": 1.45,
    "repeatSmoothingFrames": 1,
    "repeatPeakWindowSeconds": 0.12
  }
};
