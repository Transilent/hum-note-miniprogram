'use strict';

/**
 * Dependency-free MIDI reading and note-level/frame-level diagnostics for
 * HumTrans-style humming-to-MIDI evaluation.
 *
 * The 50 ms note metric follows the primary protocol of the HumTrans baseline:
 * fixed onset time (no temporal alignment), exact integer semitone pitch, and
 * one global octave shift. The 100 ms, frame, voicing and melody metrics are
 * additional diagnostics and should not be presented as the paper's full
 * metric suite.
 */

const OCTAVE_RANGE = 16;
const DEFAULT_HOP = 0.015;
const DEFAULT_TEMPO = 500000; // microseconds per quarter note (120 BPM)

const METRIC_KEYS = [
  'note_p50', 'note_r50', 'note_f50', 'note_f100',
  'absolute_f100', 'onset_f100', 'frame_pc_accuracy',
  'frame_pc_precision', 'frame_pc_recall', 'voiced_f1',
  'melody_lcs_f1', 'ratio', 'pred_count', 'ref_count'
];

function fail(message) {
  throw new Error('Invalid MIDI: ' + message);
}

function toBuffer(input) {
  if (Buffer.isBuffer(input)) return input;
  if (input instanceof ArrayBuffer) return Buffer.from(input);
  if (ArrayBuffer.isView(input)) {
    return Buffer.from(input.buffer, input.byteOffset, input.byteLength);
  }
  throw new TypeError('readMidi requires a Buffer, Uint8Array or ArrayBuffer');
}

function readU16(buffer, offset, end) {
  if (offset + 2 > end) fail('unexpected end of data');
  return buffer.readUInt16BE(offset);
}

function readU32(buffer, offset, end) {
  if (offset + 4 > end) fail('unexpected end of data');
  return buffer.readUInt32BE(offset);
}

/**
 * Read standard MIDI bytes. Timed tempo events on all tracks form one global
 * map, as required by format-1 files. Notes on MIDI channel 10 (zero-based 9)
 * are percussion and are omitted.
 *
 * @param {Buffer|Uint8Array|ArrayBuffer} input
 * @returns {Array<{start:number,end:number,midi:number}>} seconds, sorted by onset
 */
function readMidi(input) {
  const buffer = toBuffer(input);
  const length = buffer.length;
  if (length < 14 || buffer.toString('ascii', 0, 4) !== 'MThd') fail('missing MThd header');

  const headerLength = readU32(buffer, 4, length);
  if (headerLength < 6 || 8 + headerLength > length) fail('invalid MThd length');
  const format = readU16(buffer, 8, 8 + headerLength);
  const trackCount = readU16(buffer, 10, 8 + headerLength);
  const division = readU16(buffer, 12, 8 + headerLength);
  if (format !== 0 && format !== 1) fail('only MIDI formats 0 and 1 are supported');
  if (trackCount === 0) fail('MIDI contains no tracks');

  let ppq = 0;
  let smpteTicksPerSecond = 0;
  if ((division & 0x8000) === 0) {
    ppq = division;
    if (ppq === 0) fail('PPQ must be positive');
  } else {
    const signedFps = (division >> 8) - 256;
    const ticksPerFrame = division & 0xff;
    const fps = signedFps === -29 ? 29.97 : -signedFps;
    if (!(fps > 0) || ticksPerFrame === 0) fail('invalid SMPTE time division');
    smpteTicksPerSecond = fps * ticksPerFrame;
  }

  let offset = 8 + headerLength;
  let parsedTracks = 0;
  let tempoOrder = 0;
  const tempoEvents = [];
  const rawNotes = [];

  while (parsedTracks < trackCount) {
    if (offset + 8 > length) fail('missing MTrk chunk');
    const id = buffer.toString('ascii', offset, offset + 4);
    const trackLength = readU32(buffer, offset + 4, length);
    const trackStart = offset + 8;
    const trackEnd = trackStart + trackLength;
    if (trackEnd > length) fail('MTrk chunk extends past the buffer');
    offset = trackEnd;
    if (id !== 'MTrk') continue;

    let position = trackStart;
    let tick = 0;
    let runningStatus = 0;
    const active = new Map();

    function variableLength() {
      let value = 0;
      for (let i = 0; i < 4; i++) {
        if (position >= trackEnd) fail('truncated variable-length quantity');
        const byte = buffer[position++];
        value = value * 128 + (byte & 0x7f);
        if ((byte & 0x80) === 0) return value;
      }
      fail('variable-length quantity exceeds four bytes');
    }

    function need(count) {
      if (position + count > trackEnd) fail('truncated track event');
    }

    function closeNote(channel, pitch, endTick) {
      const key = channel * 128 + pitch;
      const queue = active.get(key);
      if (!queue || queue.length === 0) return;
      const startTick = queue.shift(); // FIFO is deterministic for repeated onsets.
      if (queue.length === 0) active.delete(key);
      rawNotes.push({ startTick, endTick, midi: pitch, track: parsedTracks });
    }

    while (position < trackEnd) {
      tick += variableLength();
      if (position >= trackEnd) fail('missing event status');
      let status = buffer[position++];
      let firstData = -1;

      if (status < 0x80) {
        if (!runningStatus) fail('running-status data without a prior channel status');
        firstData = status;
        status = runningStatus;
      }

      if (status === 0xff) {
        runningStatus = 0;
        need(1);
        const type = buffer[position++];
        const size = variableLength();
        need(size);
        if (type === 0x51 && size === 3) {
          const tempo = buffer.readUIntBE(position, 3);
          if (tempo > 0) tempoEvents.push({ tick, tempo, order: tempoOrder++ });
        }
        position += size;
        if (type === 0x2f) break;
        continue;
      }

      if (status === 0xf0 || status === 0xf7) {
        runningStatus = 0;
        const size = variableLength();
        need(size);
        position += size;
        continue;
      }

      if (status >= 0xf0) {
        runningStatus = 0;
        const systemDataLength = status === 0xf2 ? 2 : (status === 0xf1 || status === 0xf3 ? 1 : 0);
        need(systemDataLength);
        position += systemDataLength;
        continue;
      }

      const type = status & 0xf0;
      const channel = status & 0x0f;
      const dataLength = (type === 0xc0 || type === 0xd0) ? 1 : 2;
      need(dataLength - (firstData >= 0 ? 1 : 0));
      const data1 = firstData >= 0 ? firstData : buffer[position++];
      const data2 = dataLength === 2 ? buffer[position++] : 0;
      runningStatus = status;

      if (channel === 9) continue; // GM percussion channel.
      if (type === 0x90 && data2 > 0) {
        const key = channel * 128 + data1;
        let queue = active.get(key);
        if (!queue) active.set(key, queue = []);
        queue.push(tick);
      } else if (type === 0x80 || (type === 0x90 && data2 === 0)) {
        closeNote(channel, data1, tick);
      }
    }

    parsedTracks++;
  }

  if (parsedTracks < trackCount) fail('fewer MTrk chunks than declared in MThd');

  const tempoPoints = [];
  if (ppq) {
    tempoEvents.sort((a, b) => a.tick - b.tick || a.order - b.order);
    tempoPoints.push({ tick: 0, seconds: 0, tempo: DEFAULT_TEMPO });
    for (const event of tempoEvents) {
      const last = tempoPoints[tempoPoints.length - 1];
      if (event.tick === last.tick) {
        last.tempo = event.tempo; // At one tick, the last event governs following time.
      } else {
        tempoPoints.push({
          tick: event.tick,
          seconds: last.seconds + (event.tick - last.tick) * last.tempo / (ppq * 1e6),
          tempo: event.tempo
        });
      }
    }
  }

  function tickToSeconds(tick) {
    if (smpteTicksPerSecond) return tick / smpteTicksPerSecond;
    let low = 0;
    let high = tempoPoints.length - 1;
    while (low < high) {
      const middle = (low + high + 1) >> 1;
      if (tempoPoints[middle].tick <= tick) low = middle;
      else high = middle - 1;
    }
    const point = tempoPoints[low];
    return point.seconds + (tick - point.tick) * point.tempo / (ppq * 1e6);
  }

  const notes = rawNotes.map(note => ({
    start: tickToSeconds(note.startTick),
    end: tickToSeconds(note.endTick),
    midi: note.midi
  }));
  notes.sort((a, b) => a.start - b.start || a.end - b.end || a.midi - b.midi);
  return notes;
}

function normalizeNotes(notes, name) {
  if (!Array.isArray(notes)) throw new TypeError(name + ' must be an array');
  const result = notes.map((note, index) => {
    if (!note || !Number.isFinite(note.start) || !Number.isFinite(note.end) ||
        !Number.isFinite(note.midi)) {
      throw new TypeError(name + '[' + index + '] must contain finite start, end and midi');
    }
    return { start: note.start, end: note.end, midi: note.midi };
  });
  result.sort((a, b) => a.start - b.start || a.end - b.end || a.midi - b.midi);
  return result;
}

function f1(precision, recall) {
  if (!(precision > 0) || !(recall > 0)) return 0;
  return 2 * precision * recall / (precision + recall);
}

function ratio(numerator, denominator) {
  return denominator > 0 ? numerator / denominator : 0;
}

function maximumMatching(references, predictions, tolerance, mode, shift) {
  const refCount = references.length;
  const predCount = predictions.length;
  if (refCount === 0 || predCount === 0) return 0;

  const adjacency = new Array(refCount);
  const exactPitch = mode === 'note' || mode === 'absolute';
  for (let i = 0; i < refCount; i++) {
    const reference = references[i];
    const candidates = [];
    for (let j = 0; j < predCount; j++) {
      const prediction = predictions[j];
      if (Math.abs(reference.start - prediction.start) > tolerance + 1e-12) continue;
      if (exactPitch) {
        if (!Number.isInteger(reference.midi) || !Number.isInteger(prediction.midi)) continue;
        if (reference.midi + shift !== prediction.midi) continue;
      }
      candidates.push(j);
    }
    candidates.sort((a, b) => {
      const da = Math.abs(reference.start - predictions[a].start);
      const db = Math.abs(reference.start - predictions[b].start);
      return da - db || a - b;
    });
    adjacency[i] = candidates;
  }

  // Kuhn's augmenting-path search produces a maximum-cardinality bipartite match.
  const matchedReference = new Int32Array(predCount);
  matchedReference.fill(-1);
  const seen = new Int32Array(predCount);
  let stamp = 0;

  function augment(referenceIndex) {
    for (const predictionIndex of adjacency[referenceIndex]) {
      if (seen[predictionIndex] === stamp) continue;
      seen[predictionIndex] = stamp;
      if (matchedReference[predictionIndex] === -1 ||
          augment(matchedReference[predictionIndex])) {
        matchedReference[predictionIndex] = referenceIndex;
        return true;
      }
    }
    return false;
  }

  let matches = 0;
  for (let i = 0; i < refCount; i++) {
    stamp++;
    if (augment(i)) matches++;
  }
  return matches;
}

function octaveShiftCandidates(references, predictions) {
  // Only integral octave relations, global to the whole excerpt, are legal.
  const found = new Set([0]);
  for (const reference of references) {
    if (!Number.isInteger(reference.midi)) continue;
    for (const prediction of predictions) {
      if (!Number.isInteger(prediction.midi)) continue;
      const octaves = (prediction.midi - reference.midi) / 12;
      if (!Number.isInteger(octaves) || Math.abs(octaves) > OCTAVE_RANGE) continue;
      found.add(octaves * 12);
    }
  }
  return Array.from(found).sort((a, b) => Math.abs(a) - Math.abs(b) || a - b);
}

function bestShiftedMatch(references, predictions, tolerance) {
  let best = { matches: 0, shift: 0, f1: 0 };
  for (const shift of octaveShiftCandidates(references, predictions)) {
    const matches = maximumMatching(references, predictions, tolerance, 'note', shift);
    const precision = ratio(matches, predictions.length);
    const recall = ratio(matches, references.length);
    const score = f1(precision, recall);
    // Candidates are ordered by absolute shift, so strict > enforces the tie-break.
    if (score > best.f1) best = { matches, shift, f1: score };
  }
  return best;
}

function pitchClass(midi) {
  const value = midi % 12;
  return value < 0 ? value + 12 : value;
}

function pitchClassDistance(a, b) {
  const difference = Math.abs(pitchClass(a) - pitchClass(b));
  return Math.min(difference, 12 - difference);
}

function framePitchClasses(notes, frameCount, hop) {
  const frames = new Array(frameCount);
  for (let frame = 0; frame < frameCount; frame++) frames[frame] = new Set();
  for (const note of notes) {
    if (note.end <= note.start) continue;
    const first = Math.max(0, Math.ceil(note.start / hop - 1e-12));
    const last = Math.min(frameCount, Math.ceil(note.end / hop - 1e-12));
    const pc = pitchClass(note.midi);
    for (let frame = first; frame < last; frame++) frames[frame].add(pc);
  }
  return frames;
}

function framePitchClassMatches(referenceFrames, predictionFrames) {
  let matched = 0;
  for (let i = 0; i < referenceFrames.length; i++) {
    const references = referenceFrames[i];
    const predictions = predictionFrames[i];
    if (references.size === 0 || predictions.size === 0) continue;
    let frameMatched = false;
    outer: for (const reference of references) {
      for (const prediction of predictions) {
        if (pitchClassDistance(reference, prediction) <= 0.5 + 1e-12) {
          frameMatched = true;
          break outer;
        }
      }
    }
    if (frameMatched) matched++;
  }
  return matched;
}

function lcsLength(left, right) {
  let previous = new Int32Array(right.length + 1);
  let current = new Int32Array(right.length + 1);
  for (let i = 1; i <= left.length; i++) {
    for (let j = 1; j <= right.length; j++) {
      current[j] = left[i - 1] === right[j - 1]
        ? previous[j - 1] + 1
        : Math.max(previous[j], current[j - 1]);
    }
    const swap = previous;
    previous = current;
    current = swap;
    current.fill(0);
  }
  return previous[right.length];
}

/**
 * Score predicted notes against reference notes.
 *
 * Metric definitions:
 * - note_p50/note_r50/note_f50: exact integer pitch plus onset within 50 ms,
 *   after choosing one global octave shift for the whole excerpt by maximum
 *   bipartite matching. The shift is applied to reference pitches.
 * - note_f100: the same note matching at 100 ms, with its own F1-optimal
 *   global octave shift. global_shift reports the official-style 50 ms choice.
 * - absolute_f100: exact pitch, 100 ms, no octave shift.
 * - onset_f100: 100 ms maximum matching that ignores pitch.
 * - Frame times are 0, hop, ... below duration. A PC matches when circular
 *   pitch-class distance is <= 0.5 semitone. Precision uses every predicted
 *   voiced frame; recall uses every reference voiced frame. frame_pc_accuracy
 *   intentionally equals frame_pc_recall because its denominator is reference
 *   voiced frames. voiced_f1 uses only frame activity, without pitch.
 * - melody_lcs_f1 is 2*LCS/(N+M) over pitch-class note sequences; repeated
 *   adjacent notes remain distinct sequence entries.
 * - ratio is pred_count/ref_count. Any empty-denominator score is 0.
 *
 * @param {Array<{start:number,end:number,midi:number}>} ref
 * @param {Array<{start:number,end:number,midi:number}>} pred
 * @param {{duration?:number,hop?:number}} [options]
 * @returns {Record<string, number>}
 */
function scoreNotes(ref, pred, options) {
  const references = normalizeNotes(ref, 'ref');
  const predictions = normalizeNotes(pred, 'pred');
  const settings = options == null ? {} : options;
  const hop = settings.hop === undefined ? DEFAULT_HOP : settings.hop;
  if (!Number.isFinite(hop) || hop <= 0) throw new RangeError('hop must be a positive number');

  const best50 = bestShiftedMatch(references, predictions, 0.05);
  const best100 = bestShiftedMatch(references, predictions, 0.10);
  const absolute100 = maximumMatching(references, predictions, 0.10, 'absolute', 0);
  const onset100 = maximumMatching(references, predictions, 0.10, 'onset', 0);

  const noteP50 = ratio(best50.matches, predictions.length);
  const noteR50 = ratio(best50.matches, references.length);
  const absoluteF100 = f1(
    ratio(absolute100, predictions.length),
    ratio(absolute100, references.length)
  );
  const onsetF100 = f1(
    ratio(onset100, predictions.length),
    ratio(onset100, references.length)
  );

  let duration = settings.duration;
  if (duration === undefined) {
    let inferred = 0;
    for (const note of references) inferred = Math.max(inferred, note.end);
    for (const note of predictions) inferred = Math.max(inferred, note.end);
    duration = inferred;
  }
  if (!Number.isFinite(duration) || duration < 0) {
    throw new RangeError('duration must be a non-negative number');
  }
  const frameCount = Math.max(0, Math.ceil(duration / hop - 1e-12));
  const referenceFrames = framePitchClasses(references, frameCount, hop);
  const predictionFrames = framePitchClasses(predictions, frameCount, hop);

  let referenceVoiced = 0;
  let predictionVoiced = 0;
  let bothVoiced = 0;
  for (let i = 0; i < frameCount; i++) {
    const referenceActive = referenceFrames[i].size > 0;
    const predictionActive = predictionFrames[i].size > 0;
    if (referenceActive) referenceVoiced++;
    if (predictionActive) predictionVoiced++;
    if (referenceActive && predictionActive) bothVoiced++;
  }
  const matchedFrames = framePitchClassMatches(referenceFrames, predictionFrames);
  const frameRecall = ratio(matchedFrames, referenceVoiced);
  const framePrecision = ratio(matchedFrames, predictionVoiced);
  const voicedF1 = f1(
    ratio(bothVoiced, predictionVoiced),
    ratio(bothVoiced, referenceVoiced)
  );

  const referencePitchClasses = references.map(note => pitchClass(note.midi));
  const predictionPitchClasses = predictions.map(note => pitchClass(note.midi));
  const commonMelody = lcsLength(referencePitchClasses, predictionPitchClasses);
  const lcsDenominator = referencePitchClasses.length + predictionPitchClasses.length;
  const melodyLcsF1 = lcsDenominator > 0 ? 2 * commonMelody / lcsDenominator : 0;

  return {
    note_p50: noteP50,
    note_r50: noteR50,
    note_f50: best50.f1,
    note_f100: best100.f1,
    absolute_f100: absoluteF100,
    onset_f100: onsetF100,
    frame_pc_accuracy: frameRecall,
    frame_pc_precision: framePrecision,
    frame_pc_recall: frameRecall,
    voiced_f1: voicedF1,
    melody_lcs_f1: melodyLcsF1,
    ratio: ratio(predictions.length, references.length),
    pred_count: predictions.length,
    ref_count: references.length,
    global_shift: best50.shift
  };
}

function metricRecord(record) {
  if (record && record.metrics && typeof record.metrics === 'object') return record.metrics;
  if (record && record.score && typeof record.score === 'object') return record.score;
  return record || {};
}

function compositionOf(record) {
  const composition = record && (
    record.composition_id !== undefined ? record.composition_id :
      record.compositionId !== undefined ? record.compositionId :
        record.meta && record.meta.composition_id
  );
  if (composition === undefined || composition === null || composition === '') {
    throw new TypeError('Every aggregate record needs composition_id');
  }
  return String(composition);
}

/**
 * Hierarchical macro average: average takes within each composition first,
 * then average those composition means. This prevents works with more takes
 * from receiving extra weight.
 *
 * @param {Array<object>} records Flat metrics with composition_id, or records
 *   with a metrics/score object.
 * @returns {{count:number,compositions:number,metrics:Record<string,number>}}
 */
function aggregate(records) {
  if (!Array.isArray(records)) throw new TypeError('records must be an array');
  const groups = new Map();
  for (const record of records) {
    const composition = compositionOf(record);
    if (!groups.has(composition)) groups.set(composition, []);
    groups.get(composition).push(metricRecord(record));
  }

  const metrics = {};
  for (const key of METRIC_KEYS) {
    const compositionMeans = [];
    for (const group of groups.values()) {
      const values = group
        .map(record => record[key])
        .filter(value => Number.isFinite(value));
      if (values.length) {
        compositionMeans.push(values.reduce((sum, value) => sum + value, 0) / values.length);
      }
    }
    metrics[key] = compositionMeans.length
      ? compositionMeans.reduce((sum, value) => sum + value, 0) / compositionMeans.length
      : 0;
  }

  const global_shift_counts = {};
  for (const record of records) {
    const shift = metricRecord(record).global_shift;
    if (Number.isFinite(shift)) global_shift_counts[shift] = (global_shift_counts[shift] || 0) + 1;
  }
  return { count: records.length, compositions: groups.size, metrics, global_shift_counts };
}

module.exports = { readMidi, scoreNotes, aggregate };
