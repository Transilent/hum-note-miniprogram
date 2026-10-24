'use strict';

// Frame-to-note segmentation for HumTrans experiments.
//
// A frame's MIDI value describes a pitch-analysis window whose first sample is
// at index * hopSeconds. The emitted note therefore starts at that frame time
// and ends one hop after its last frame. No audio look-back or onset centering
// is performed here.

const { clamp, uid } = require('../miniprogram/utils/music');

const EPSILON = 1e-9;

const DEFAULT_OPTIONS = Object.freeze({
  medianWindow: 3,
  confidenceThreshold: 0.25,
  minActiveRms: 0.001,
  hysteresisSemitones: 0.65,
  stableFrames: 3,
  bridgeFrames: 2,
  bridgeMaxSeconds: 0.035,
  bridgeRmsRatio: 0.12,
  minNoteBeats: 0.125,
  shortFragmentPolicy: 'drop',
  splitRepeatedNotes: false,
  repeatMinNoteBeats: 0.25,
  repeatValleyRatio: 0.55,
  repeatRecoveryRatio: 1.4,
  repeatSmoothingFrames: 3,
  repeatPeakWindowSeconds: 0.12
});

function finiteNumber(value, fallback) {
  return Number.isFinite(value) ? value : fallback;
}

function integerOption(value, fallback, minimum, maximum) {
  if (!Number.isFinite(value)) return fallback;
  return clamp(Math.round(value), minimum, maximum);
}

function normalizeOptions(options) {
  const source = options && typeof options === 'object' ? options : {};
  const medianWindow = [1, 3, 5].indexOf(source.medianWindow) >= 0
    ? source.medianWindow : DEFAULT_OPTIONS.medianWindow;
  const policy = source.shortFragmentPolicy === 'merge' ? 'merge' : 'drop';
  const smoothing = integerOption(source.repeatSmoothingFrames,
    DEFAULT_OPTIONS.repeatSmoothingFrames, 1, 9);

  return {
    medianWindow,
    confidenceThreshold: clamp(finiteNumber(source.confidenceThreshold,
      DEFAULT_OPTIONS.confidenceThreshold), 0, 1),
    minActiveRms: Math.max(0, finiteNumber(source.minActiveRms,
      DEFAULT_OPTIONS.minActiveRms)),
    hysteresisSemitones: clamp(finiteNumber(source.hysteresisSemitones,
      DEFAULT_OPTIONS.hysteresisSemitones), 0, 1.25),
    stableFrames: integerOption(source.stableFrames,
      DEFAULT_OPTIONS.stableFrames, 1, 12),
    bridgeFrames: integerOption(source.bridgeFrames,
      DEFAULT_OPTIONS.bridgeFrames, 0, 20),
    bridgeMaxSeconds: clamp(finiteNumber(source.bridgeMaxSeconds,
      DEFAULT_OPTIONS.bridgeMaxSeconds), 0, 0.5),
    bridgeRmsRatio: clamp(finiteNumber(source.bridgeRmsRatio,
      DEFAULT_OPTIONS.bridgeRmsRatio), 0, 1),
    minNoteBeats: clamp(finiteNumber(source.minNoteBeats,
      DEFAULT_OPTIONS.minNoteBeats), 0, 32),
    shortFragmentPolicy: policy,
    splitRepeatedNotes: source.splitRepeatedNotes === true,
    repeatMinNoteBeats: clamp(finiteNumber(source.repeatMinNoteBeats,
      DEFAULT_OPTIONS.repeatMinNoteBeats), 0, 32),
    repeatValleyRatio: clamp(finiteNumber(source.repeatValleyRatio,
      DEFAULT_OPTIONS.repeatValleyRatio), 0.05, 0.95),
    repeatRecoveryRatio: clamp(finiteNumber(source.repeatRecoveryRatio,
      DEFAULT_OPTIONS.repeatRecoveryRatio), 1.05, 5),
    repeatSmoothingFrames: smoothing % 2 ? smoothing : smoothing + 1,
    repeatPeakWindowSeconds: clamp(finiteNumber(source.repeatPeakWindowSeconds,
      DEFAULT_OPTIONS.repeatPeakWindowSeconds), 0.015, 0.25)
  };
}

function round3(value) {
  const rounded = Math.round(value * 1000) / 1000;
  return Object.is(rounded, -0) ? 0 : rounded;
}

function round9(value) {
  const rounded = Math.round(value * 1e9) / 1e9;
  return Object.is(rounded, -0) ? 0 : rounded;
}

function average(values) {
  if (!values.length) return 0;
  let sum = 0;
  for (let i = 0; i < values.length; i++) sum += values[i];
  return sum / values.length;
}

function median(values) {
  if (!values.length) return null;
  const ordered = values.slice().sort((a, b) => a - b);
  const middle = Math.floor(ordered.length / 2);
  return ordered.length % 2 ? ordered[middle] : (ordered[middle - 1] + ordered[middle]) / 2;
}

function prepareFrames(frames, config) {
  return frames.map(function (frame) {
    const rawMidi = frame && Number.isFinite(frame.midi) ? frame.midi : null;
    const confidence = frame ? clamp(finiteNumber(frame.confidence, 0), 0, 1) : 0;
    const rms = frame ? Math.max(0, finiteNumber(frame.rms, 0)) : 0;
    const midi = rawMidi != null && rawMidi >= 0 && rawMidi <= 127 &&
      confidence >= config.confidenceThreshold ? rawMidi : null;
    return { midi, confidence, rms };
  });
}

// Median-filter the continuous F0 while retaining the center frame's validity.
// Nulls are never invented by the filter, which keeps a clear rest clear.
function medianFilterPitch(frames, width) {
  if (width <= 1) return frames.map(function (frame) {
    return { midi: frame.midi, confidence: frame.confidence, rms: frame.rms };
  });

  const half = Math.floor(width / 2);
  const requiredSupport = Math.ceil(width / 2);
  return frames.map(function (frame, index) {
    if (frame.midi == null) return { midi: null, confidence: frame.confidence, rms: frame.rms };
    const values = [];
    const begin = Math.max(0, index - half);
    const end = Math.min(frames.length, index + half + 1);
    for (let i = begin; i < end; i++) {
      if (frames[i].midi != null) values.push(frames[i].midi);
    }
    return {
      midi: values.length >= requiredSupport ? median(values) : null,
      confidence: frame.confidence,
      rms: frame.rms
    };
  });
}

// A semitone boundary needs to be crossed slightly decisively. A changed pitch
// is then held as a candidate until stableFrames agree; once confirmed, the
// candidate's first frame becomes the onset, so confirmation does not delay it.
function confirmStablePitches(frames, config) {
  const output = new Array(frames.length).fill(null);
  let current = null;
  let pendingPitch = null;
  let pendingStart = -1;
  let pendingCount = 0;

  function clearPending() {
    pendingPitch = null;
    pendingStart = -1;
    pendingCount = 0;
  }

  for (let index = 0; index < frames.length; index++) {
    const frame = frames[index];
    if (frame.midi == null) {
      output[index] = null;
      clearPending();
      continue;
    }

    const nearest = clamp(Math.round(frame.midi), 0, 127);
    if (current == null) {
      current = nearest;
      output[index] = current;
      clearPending();
      continue;
    }

    const heldByHysteresis = Math.abs(frame.midi - current) <= config.hysteresisSemitones;
    if (nearest === current || heldByHysteresis) {
      output[index] = current;
      clearPending();
      continue;
    }

    if (pendingPitch === nearest) {
      pendingCount++;
    } else {
      pendingPitch = nearest;
      pendingStart = index;
      pendingCount = 1;
    }
    output[index] = current;

    if (pendingCount >= config.stableFrames) {
      for (let i = pendingStart; i <= index; i++) output[i] = nearest;
      current = nearest;
      clearPending();
    }
  }

  return output;
}

function edgeRms(frames, index) {
  const values = [frames[index].rms];
  if (index > 0) values.push(frames[index - 1].rms);
  if (index + 1 < frames.length) values.push(frames[index + 1].rms);
  return median(values);
}

// Bridge only very short same-pitch dropouts with measurable energy. The frame
// and duration caps prevent a clean breath/rest from becoming a sustained note.
function bridgeShortDropouts(timeline, frames, hopSeconds, config) {
  const output = timeline.slice();
  const durationCap = Math.floor(config.bridgeMaxSeconds / hopSeconds + EPSILON);
  const frameCap = Math.min(config.bridgeFrames, durationCap);
  if (frameCap <= 0) return output;

  let index = 0;
  while (index < output.length) {
    if (output[index] != null) {
      index++;
      continue;
    }
    const start = index;
    while (index < output.length && output[index] == null) index++;
    const end = index;
    const left = start - 1;
    const right = end;
    const gapLength = end - start;

    if (gapLength > frameCap || left < 0 || right >= output.length ||
        output[left] == null || output[left] !== output[right]) continue;

    const gapRmsValues = [];
    for (let i = start; i < end; i++) gapRmsValues.push(frames[i].rms);
    const gapRms = average(gapRmsValues);
    const neighbourRms = Math.min(edgeRms(frames, left), edgeRms(frames, right));
    if (gapRms < config.minActiveRms) continue;
    if (neighbourRms > EPSILON && gapRms < neighbourRms * config.bridgeRmsRatio) continue;

    for (let i = start; i < end; i++) output[i] = output[left];
  }
  return output;
}

function makeRuns(timeline) {
  const runs = [];
  let start = 0;
  while (start < timeline.length) {
    const pitch = timeline[start];
    let end = start + 1;
    while (end < timeline.length && timeline[end] === pitch) end++;
    runs.push({ pitch, start, end });
    start = end;
  }
  return runs;
}

function regionRms(frames, start, end) {
  const values = [];
  for (let i = start; i < end; i++) values.push(frames[i].rms);
  return average(values);
}

function resolveShortFragments(timeline, frames, minFrames, policy) {
  const output = timeline.slice();
  let guard = 0;

  while (guard++ <= output.length) {
    const runs = makeRuns(output);
    let shortIndex = -1;
    for (let i = 0; i < runs.length; i++) {
      const run = runs[i];
      if (run.pitch != null && run.end - run.start < minFrames) {
        shortIndex = i;
        break;
      }
    }
    if (shortIndex < 0) break;

    const run = runs[shortIndex];
    let replacement = null;
    if (policy === 'merge') {
      const left = shortIndex > 0 && runs[shortIndex - 1].end === run.start ?
        runs[shortIndex - 1] : null;
      const right = shortIndex + 1 < runs.length && runs[shortIndex + 1].start === run.end ?
        runs[shortIndex + 1] : null;
      const neighbours = [];
      if (left && left.pitch != null) neighbours.push(left);
      if (right && right.pitch != null) neighbours.push(right);

      if (neighbours.length === 2 && neighbours[0].pitch === neighbours[1].pitch) {
        replacement = neighbours[0].pitch;
      } else if (neighbours.length) {
        neighbours.sort(function (a, b) {
          const lengthDelta = (b.end - b.start) - (a.end - a.start);
          if (lengthDelta) return lengthDelta;
          return regionRms(frames, b.start, b.end) - regionRms(frames, a.start, a.end);
        });
        replacement = neighbours[0].pitch;
      }
    }

    for (let i = run.start; i < run.end; i++) output[i] = replacement;
  }

  return output;
}

function smoothRms(frames, start, end, width) {
  const half = Math.floor(width / 2);
  const result = new Array(end - start);
  for (let i = start; i < end; i++) {
    const begin = Math.max(start, i - half);
    const finish = Math.min(end, i + half + 1);
    const values = [];
    for (let j = begin; j < finish; j++) values.push(frames[j].rms);
    result[i - start] = average(values);
  }
  return result;
}

function splitRepeatedRun(run, frames, hopSeconds, bpm, minFrames, config) {
  if (!config.splitRepeatedNotes) return [{ pitch: run.pitch, start: run.start, end: run.end }];

  const beatsPerFrame = hopSeconds * bpm / 60;
  const splitMinimumBeats = Math.max(config.minNoteBeats, config.repeatMinNoteBeats);
  const sideFrames = Math.max(minFrames,
    Math.ceil(splitMinimumBeats / beatsPerFrame - EPSILON));
  if (run.end - run.start < sideFrames * 2 + 1) {
    return [{ pitch: run.pitch, start: run.start, end: run.end }];
  }

  const envelope = smoothRms(frames, run.start, run.end, config.repeatSmoothingFrames);
  const peakWindowFrames = Math.max(1,
    Math.round(config.repeatPeakWindowSeconds / hopSeconds));
  const candidates = [];

  for (let frameIndex = run.start + sideFrames; frameIndex < run.end - sideFrames; frameIndex++) {
    const local = frameIndex - run.start;
    const valley = envelope[local];
    const previous = envelope[Math.max(0, local - 1)];
    const next = envelope[Math.min(envelope.length - 1, local + 1)];
    if (valley > previous + EPSILON || valley > next + EPSILON) continue;

    let leftPeak = 0;
    let rightPeak = 0;
    let leftBegin = Math.max(run.start, frameIndex - peakWindowFrames);
    let rightEnd = Math.min(run.end, frameIndex + peakWindowFrames + 1);
    for (let i = leftBegin; i <= frameIndex; i++) leftPeak = Math.max(leftPeak, envelope[i - run.start]);
    for (let i = frameIndex; i < rightEnd; i++) rightPeak = Math.max(rightPeak, envelope[i - run.start]);

    if (leftPeak < config.minActiveRms || rightPeak < config.minActiveRms) continue;
    if (valley > leftPeak * config.repeatValleyRatio ||
        valley > rightPeak * config.repeatValleyRatio) continue;
    if (leftPeak < valley * config.repeatRecoveryRatio ||
        rightPeak < valley * config.repeatRecoveryRatio) continue;

    const depth = 1 - valley / Math.max(EPSILON, Math.max(leftPeak, rightPeak));
    const recovery = Math.min(leftPeak, rightPeak) / Math.max(EPSILON, valley);
    candidates.push({ frame: frameIndex, score: depth * recovery });
  }

  candidates.sort(function (a, b) {
    return b.score - a.score || a.frame - b.frame;
  });
  const accepted = [];
  for (let i = 0; i < candidates.length; i++) {
    const candidate = candidates[i].frame;
    let separated = true;
    for (let j = 0; j < accepted.length; j++) {
      if (Math.abs(candidate - accepted[j]) < sideFrames) {
        separated = false;
        break;
      }
    }
    if (separated) accepted.push(candidate);
  }
  accepted.sort(function (a, b) { return a - b; });
  if (!accepted.length) return [{ pitch: run.pitch, start: run.start, end: run.end }];

  const boundaries = [run.start].concat(accepted, [run.end]);
  const pieces = [];
  for (let i = 0; i + 1 < boundaries.length; i++) {
    pieces.push({ pitch: run.pitch, start: boundaries[i], end: boundaries[i + 1] });
  }
  return pieces;
}

function notesFromRuns(runs, frames, hopSeconds, bpm, config) {
  const secondsPerBeat = 60 / bpm;
  const noteRuns = [];

  for (let i = 0; i < runs.length; i++) {
    const run = runs[i];
    if (run.pitch == null) continue;
    const pieces = splitRepeatedRun(run, frames, hopSeconds, bpm,
      Math.max(1, Math.ceil(config.minNoteBeats / (hopSeconds / secondsPerBeat) - EPSILON)),
      config);
    for (let j = 0; j < pieces.length; j++) noteRuns.push(pieces[j]);
  }

  const notes = [];
  for (let i = 0; i < noteRuns.length; i++) {
    const run = noteRuns[i];
    // Round both boundaries before subtracting. This keeps adjacent rounded
    // onsets/offsets identical and avoids a 0.001-beat overlap from separately
    // rounding onset and duration.
    const start = round3(run.start * hopSeconds / secondsPerBeat);
    const end = round3(run.end * hopSeconds / secondsPerBeat);
    const duration = round3(end - start);
    if (!(duration + 1e-8 >= config.minNoteBeats) || duration <= 0) continue;

    const confidenceValues = [];
    const rmsValues = [];
    for (let frameIndex = run.start; frameIndex < run.end; frameIndex++) {
      confidenceValues.push(frames[frameIndex].confidence);
      rmsValues.push(frames[frameIndex].rms);
    }
    const confidence = clamp(average(confidenceValues), 0, 1);
    const velocity = Math.round(clamp(65 + average(rmsValues) * 160, 60, 110));

    notes.push({
      id: uid(),
      midi: run.pitch,
      start,
      duration,
      velocity,
      confidence: round9(confidence)
    });
  }

  notes.sort(function (a, b) { return a.start - b.start; });
  for (let i = 1; i < notes.length; i++) {
    const previousEnd = notes[i - 1].start + notes[i - 1].duration;
    if (previousEnd > notes[i].start + EPSILON) {
      throw new Error('segmentation produced overlapping notes');
    }
  }
  return notes;
}

function segmentFrames(frames, hopSeconds, bpm, options) {
  if (!Array.isArray(frames)) throw new TypeError('frames must be an array');
  if (!Number.isFinite(hopSeconds) || hopSeconds <= 0) {
    throw new TypeError('hopSeconds must be a positive finite number');
  }
  if (!Number.isFinite(bpm) || bpm <= 0) {
    throw new TypeError('bpm must be a positive finite number');
  }
  if (!frames.length) return [];

  const config = normalizeOptions(options);
  const prepared = prepareFrames(frames, config);
  const filtered = medianFilterPitch(prepared, config.medianWindow);
  let timeline = confirmStablePitches(filtered, config);
  timeline = bridgeShortDropouts(timeline, prepared, hopSeconds, config);

  const beatsPerFrame = hopSeconds * bpm / 60;
  const minFrames = Math.max(1,
    Math.ceil(config.minNoteBeats / beatsPerFrame - EPSILON));
  timeline = resolveShortFragments(timeline, prepared, minFrames,
    config.shortFragmentPolicy);

  return notesFromRuns(makeRuns(timeline), prepared, hopSeconds, bpm, config);
}

function candidate(name, description, overrides) {
  return Object.freeze({
    name,
    description,
    options: Object.freeze(Object.assign({}, DEFAULT_OPTIONS, overrides || {}))
  });
}

// Eight deliberately different operating points. Select on valid_clean, freeze
// the chosen options, and only then evaluate on test.
const CANDIDATES = Object.freeze([
  candidate('m3_balanced',
    'Default: 3-frame median and moderate confirmation for general clean humming.'),
  candidate('m3_responsive',
    'Faster 2-frame confirmation and a single-frame bridge for short, rapid notes.', {
      confidenceThreshold: 0.2,
      hysteresisSemitones: 0.5,
      stableFrames: 2,
      bridgeFrames: 1,
      bridgeMaxSeconds: 0.02
    }),
  candidate('m3_rest_safe',
    'Shortest dropouts only, with a stricter energy test to protect clear rests.', {
      confidenceThreshold: 0.25,
      hysteresisSemitones: 0.7,
      stableFrames: 3,
      bridgeFrames: 1,
      bridgeMaxSeconds: 0.015,
      bridgeRmsRatio: 0.22,
      minActiveRms: 0.002
    }),
  candidate('m5_smooth',
    '5-frame median and 4-frame confirmation for jittery but sustained F0 contours.', {
      medianWindow: 5,
      confidenceThreshold: 0.3,
      hysteresisSemitones: 0.75,
      stableFrames: 4,
      bridgeFrames: 3,
      bridgeMaxSeconds: 0.05
    }),
  candidate('m5_conservative',
    '5-frame median, stricter confidence, and short-only dropout bridging.', {
      medianWindow: 5,
      confidenceThreshold: 0.35,
      hysteresisSemitones: 0.8,
      stableFrames: 4,
      bridgeFrames: 2,
      bridgeMaxSeconds: 0.03,
      bridgeRmsRatio: 0.18
    }),
  candidate('m3_merge_fragments',
    '3-frame median with sub-minimum pitch blips absorbed by the stronger neighbour.', {
      shortFragmentPolicy: 'merge'
    }),
  candidate('m3_repeat_aware',
    'Balanced segmentation plus conservative RMS valley/recovery splits for repeated pitch.', {
      splitRepeatedNotes: true,
      repeatMinNoteBeats: 0.25,
      repeatValleyRatio: 0.5,
      repeatRecoveryRatio: 1.45,
      repeatSmoothingFrames: 1
    }),
  candidate('m5_repeat_aware',
    'Smooth 5-frame segmentation plus conservative repeated-pitch amplitude splits.', {
      medianWindow: 5,
      confidenceThreshold: 0.3,
      hysteresisSemitones: 0.75,
      stableFrames: 4,
      bridgeFrames: 3,
      bridgeMaxSeconds: 0.05,
      splitRepeatedNotes: true,
      repeatMinNoteBeats: 0.25,
      repeatValleyRatio: 0.5,
      repeatRecoveryRatio: 1.45,
      repeatSmoothingFrames: 1
    })
]);

module.exports = {
  segmentFrames,
  CANDIDATES,
  DEFAULT_OPTIONS
};

