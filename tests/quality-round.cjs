'use strict';

// Quality corpus round-trip and invariants. This file has no auto-run side
// effects when required, and never uploads audio or opens a simulator.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const fixtures = require('../tools/quality-fixtures.cjs');

const DEFAULT_ROOT = path.resolve(__dirname, '..');
const OVERLAP_EPSILON = 1e-6;
const TICK_EPSILON = 1e-9;

function clone(value) { return JSON.parse(JSON.stringify(value)); }
function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  Object.keys(value).forEach(function (key) { deepFreeze(value[key]); });
  return value;
}
function stableNotes(notes) {
  return notes.slice().sort(function (a, b) {
    return a.start - b.start || a.midi - b.midi || a.duration - b.duration || String(a.id).localeCompare(String(b.id));
  });
}
function musicalFields(notes) {
  return stableNotes(notes).map(function (item) { return { midi: item.midi, start: item.start, duration: item.duration }; });
}
function sortedIds(ids) {
  return ids.slice().sort(function (a, b) { return String(a).localeCompare(String(b)); });
}
function invariant(value, context) {
  if (!value) throw new Error(typeof context === 'string' ? context : JSON.stringify(context, null, 2));
}
function close(actual, expected, tolerance, context) {
  if (!Number.isFinite(actual) || Math.abs(actual - expected) > tolerance) {
    throw new Error((context || 'numeric mismatch') + ': actual=' + actual + ', expected=' + expected + ', tolerance=' + tolerance);
  }
}
function assertMusicalFields(actual, expected, tolerance, label) {
  const actualFields = musicalFields(actual), expectedFields = musicalFields(expected);
  if (actualFields.length !== expectedFields.length) {
    throw new Error(label + ': note count ' + actualFields.length + ' !== ' + expectedFields.length +
      '\nactual=' + JSON.stringify(actualFields) + '\nexpected=' + JSON.stringify(expectedFields));
  }
  for (let index = 0; index < expectedFields.length; index++) {
    const a = actualFields[index], e = expectedFields[index];
    if (a.midi !== e.midi) {
      throw new Error(label + ': note ' + index + ' pitch ' + a.midi + ' !== ' + e.midi +
        '\nactual=' + JSON.stringify(actualFields) + '\nexpected=' + JSON.stringify(expectedFields));
    }
    close(a.start, e.start, tolerance, label + ': note ' + index + ' start');
    close(a.duration, e.duration, tolerance, label + ': note ' + index + ' duration');
  }
}

// This parser intentionally shares no code with miniprogram/utils/midi.js.
// It supports the small SMF subset emitted by the app plus running status.
function readVlq(buffer, state, label) {
  let value = 0, count = 0;
  for (;;) {
    invariant(state.at < buffer.length, label + ': truncated VLQ');
    const byte = buffer[state.at++];
    value = value * 128 + (byte & 0x7f); count++;
    if (!(byte & 0x80)) return value;
    invariant(count < 5, label + ': VLQ longer than four bytes');
  }
}
function readUint32BE(buffer, at, label) {
  invariant(at + 4 <= buffer.length, label + ': truncated uint32');
  return buffer.readUInt32BE(at);
}
function readIndependentMidi(input, label) {
  const buffer = Buffer.isBuffer(input) ? input : Buffer.from(input);
  invariant(buffer.length >= 22, label + ': MIDI is too short');
  invariant(buffer.toString('ascii', 0, 4) === 'MThd', label + ': missing MThd');
  const headerLength = readUint32BE(buffer, 4, label);
  invariant(headerLength >= 6 && 8 + headerLength <= buffer.length, label + ': invalid header length');
  const format = buffer.readUInt16BE(8), trackCount = buffer.readUInt16BE(10), division = buffer.readUInt16BE(12);
  invariant((division & 0x8000) === 0 && division > 0, label + ': expected PPQ timing');
  const ppq = division, tracks = [], notes = [], tempoEvents = [];
  let at = 8 + headerLength;
  for (let trackIndex = 0; trackIndex < trackCount; trackIndex++) {
    invariant(at + 8 <= buffer.length, label + ': missing track ' + trackIndex);
    invariant(buffer.toString('ascii', at, at + 4) === 'MTrk', label + ': missing MTrk ' + trackIndex);
    const length = readUint32BE(buffer, at + 4, label), startAt = at + 8, endAt = startAt + length;
    invariant(endAt <= buffer.length, label + ': truncated track ' + trackIndex);
    const state = { at: startAt };
    let tick = 0, runningStatus = null, events = 0;
    const active = new Map();
    while (state.at < endAt) {
      tick += readVlq(buffer, state, label + '/track ' + trackIndex);
      invariant(state.at < endAt, label + ': missing event status');
      let status = buffer[state.at];
      if (status & 0x80) {
        state.at++;
        if (status < 0xf0) runningStatus = status; else runningStatus = null;
      } else {
        invariant(runningStatus != null, label + ': data byte without running status');
        status = runningStatus;
      }
      if (status === 0xff) {
        invariant(state.at < endAt, label + ': truncated meta type');
        const type = buffer[state.at++], size = readVlq(buffer, state, label);
        invariant(state.at + size <= endAt, label + ': truncated meta event');
        if (type === 0x51) {
          invariant(size === 3, label + ': tempo meta must have three bytes');
          const micros = buffer.readUIntBE(state.at, 3);
          invariant(micros > 0, label + ': zero tempo');
          tempoEvents.push({ tick, micros });
        }
        state.at += size; runningStatus = null;
        if (type === 0x2f) break;
      } else if (status === 0xf0 || status === 0xf7) {
        const size = readVlq(buffer, state, label);
        invariant(state.at + size <= endAt, label + ': truncated sysex');
        state.at += size; runningStatus = null;
      } else {
        const kind = status & 0xf0, channel = status & 0x0f;
        const dataLength = (kind === 0xc0 || kind === 0xd0) ? 1 : 2;
        invariant(state.at + dataLength <= endAt, label + ': truncated channel event');
        const data1 = buffer[state.at++], data2 = dataLength === 2 ? buffer[state.at++] : 0;
        const key = channel + ':' + data1;
        if (kind === 0x90 && data2 > 0) {
          invariant(!active.has(key), label + ': note-on while pitch is still active');
          active.set(key, { midi: data1, startTick: tick, velocity: data2, channel });
        } else if (kind === 0x80 || kind === 0x90) {
          const started = active.get(key);
          invariant(started, label + ': note-off without active pitch');
          active.delete(key); invariant(tick > started.startTick, label + ': zero-length note');
          notes.push(Object.assign(started, { endTick: tick }));
        }
      }
      events++; invariant(events < 10000, label + ': event loop guard exceeded');
    }
    invariant(state.at === endAt, label + ': track length mismatch');
    invariant(active.size === 0, label + ': note(s) left active at track end');
    tracks.push({ index: trackIndex, length, events, tick });
    at = endAt;
  }
  invariant(at === buffer.length, label + ': trailing bytes after declared tracks');
  invariant(tempoEvents.length >= 1, label + ': no tempo event');
  const tempo = tempoEvents[0].micros;
  const parsedNotes = notes.map(function (item) {
    return { midi: item.midi, start: item.startTick / ppq, duration: (item.endTick - item.startTick) / ppq,
      velocity: item.velocity, track: 0 };
  });
  const endTick = parsedNotes.reduce(function (maximum, item) { return Math.max(maximum, item.start + item.duration); }, 0) * ppq;
  return { format, trackCount, ppq, tempo, bpm: 60000000 / tempo, tempoEvents, notes: parsedNotes, endTick, tracks };
}
function assertMidiRoundTrip(encodeMidi, source, bpm, label) {
  const before = clone(source), buffer = encodeMidi(source, bpm);
  assert.deepEqual(source, before, label + ': encodeMidi mutated source notes');
  const parsed = readIndependentMidi(buffer, label);
  invariant(parsed.format === 0 || parsed.format === 1, label + ': unsupported SMF format ' + parsed.format);
  invariant(parsed.trackCount === parsed.tracks.length && parsed.trackCount >= 1, label + ': inconsistent track count');
  invariant(parsed.notes.length === source.length, label + ': parsed ' + parsed.notes.length + ' notes, expected ' + source.length);
  const actual = stableNotes(parsed.notes), expected = stableNotes(source), tolerance = 1 / parsed.ppq + TICK_EPSILON;
  for (let index = 0; index < expected.length; index++) {
    const a = actual[index], e = expected[index];
    if (a.midi !== e.midi) {
      throw new Error(label + ': note ' + index + ' pitch mismatch: ' + a.midi + ' !== ' + e.midi +
        '\nactual=' + JSON.stringify(actual.slice(0, 8)) + '\nexpected=' + JSON.stringify(expected.slice(0, 8)));
    }
    close(a.start, e.start, tolerance, label + ': note ' + index + ' start');
    close(a.duration, e.duration, tolerance, label + ': note ' + index + ' duration');
    if (Number.isFinite(e.velocity)) invariant(a.velocity === e.velocity, label + ': note ' + index + ' velocity mismatch');
  }
  const expectedTempo = Math.round(60000000 / Math.max(40, Math.min(240, Number(bpm))));
  invariant(parsed.tempo === expectedTempo, label + ': tempo micros ' + parsed.tempo + ' !== ' + expectedTempo);
  close(parsed.bpm, Number(bpm), 0.001, label + ': BPM');
  return parsed;
}
function overlapsOracle(notes) {
  const ids = new Set(), pairs = [];
  for (let left = 0; left < notes.length; left++) {
    for (let right = left + 1; right < notes.length; right++) {
      const a = notes[left], b = notes[right];
      const overlaps = a.start < b.start + b.duration - OVERLAP_EPSILON && b.start < a.start + a.duration - OVERLAP_EPSILON;
      if (overlaps) { ids.add(a.id); ids.add(b.id); pairs.push([left, right, a.id, b.id]); }
    }
  }
  return { ids: sortedIds(Array.from(ids)), pairCount: pairs.length, pairs };
}
function assertOverlapMatch(actual, oracle, context) {
  const actualIds = sortedIds(actual.ids);
  if (actual.pairCount !== oracle.pairCount || JSON.stringify(actualIds) !== JSON.stringify(oracle.ids)) {
    throw new Error('getOverlaps mismatch\ncontext=' + JSON.stringify(context, null, 2) +
      '\nactual=' + JSON.stringify({ pairCount: actual.pairCount, ids: actualIds }) +
      '\nexpected=' + JSON.stringify({ pairCount: oracle.pairCount, ids: oracle.ids }) +
      '\nfirstExpectedPairs=' + JSON.stringify(oracle.pairs.slice(0, 12)));
  }
}
function randomValidNotes(random, count) {
  const pitches = [21, 28, 36, 48, 60, 64, 67, 72, 84, 96, 108], notes = [];
  for (let index = 0; index < count; index++) {
    notes.push({ id: 'random-' + index, midi: pitches[Math.floor(random() * pitches.length)],
      start: Math.round(random() * 24000) / 1000, duration: 0.125 + Math.floor(random() * 64) * 0.125,
      velocity: 1 + Math.floor(random() * 127) });
  }
  for (let index = notes.length - 1; index > 0; index--) {
    const swap = Math.floor(random() * (index + 1)), value = notes[index];
    notes[index] = notes[swap]; notes[swap] = value;
  }
  return notes;
}
function loadTarget(root) {
  const target = path.resolve(root || DEFAULT_ROOT);
  const files = {
    music: path.join(target, 'miniprogram', 'utils', 'music.js'), midi: path.join(target, 'miniprogram', 'utils', 'midi.js'),
    pitch: path.join(target, 'miniprogram', 'utils', 'pitch.js'), wav: path.join(target, 'miniprogram', 'utils', 'wav.js'),
    audio: path.join(target, 'miniprogram', 'utils', 'audio.js'), composition: path.join(target, 'miniprogram', 'utils', 'composition.js'),
    storage: path.join(target, 'miniprogram', 'utils', 'storage.js')
  };
  Object.keys(files).forEach(function (key) { invariant(fs.existsSync(files[key]), 'target project is missing ' + files[key]); });
  const loaded = { root: target };
  Object.keys(files).forEach(function (key) { loaded[key] = require(files[key]); });
  return loaded;
}

async function run(options) {
  const opts = options || {}, log = opts.log || function () {};
  const target = loadTarget(opts.root);
  const { music, midi, pitch, wav, composition, storage } = target;
  const results = { root: target.root, passed: 0, failed: 0, failures: [], metrics: {} };
  let ordinal = 0;

  async function check(label, fn) {
    ordinal++;
    const started = performance.now();
    try {
      const detail = await fn();
      results.passed++;
      log('PASS ' + String(ordinal).padStart(2, '0') + '  ' + label +
        (detail == null ? '' : ' (' + detail + ')') + ' [' + (performance.now() - started).toFixed(1) + ' ms]');
    } catch (error) {
      results.failed++;
      results.failures.push({ label, error });
      log('FAIL ' + String(ordinal).padStart(2, '0') + '  ' + label);
      log(error && error.stack || String(error));
    }
  }

  await check('fixtures 固定种子重复生成完全一致，且不依赖全局随机数', async function () {
    const originalRandom = Math.random;
    Math.random = function () { throw new Error('fixture code touched Math.random'); };
    try {
      for (const name of ['single-note', 'unequal-rests', 'octave-boundaries', 'dense-500',
        'two-minute-boundary', 'nested-overlaps', 'long-title', 'known-melody']) {
        assert.deepEqual(fixtures.getFixture(name), fixtures.getFixture(name), name + ' is not deterministic');
      }
      for (const rate of fixtures.SAMPLE_RATES) {
        for (const name of ['audio-silence', 'audio-noise', 'audio-harmonic-vibrato']) {
          assert.deepEqual(fixtures.describeFixture(name, { sampleRate: rate }),
            fixtures.describeFixture(name, { sampleRate: rate }), name + ' at ' + rate + ' Hz is not deterministic');
        }
      }
    } finally { Math.random = originalRandom; }
    return 'notes + audio x ' + fixtures.SAMPLE_RATES.length + ' rates';
  });

  await check('独立 MIDI 读取器核对单音、起点、时值与 BPM', async function () {
    const item = fixtures.singleNote();
    const parsed = assertMidiRoundTrip(midi.encodeMidi, item.notes, item.bpm, 'single-note');
    invariant(parsed.notes[0].midi === 69 && parsed.notes[0].velocity === 93,
      'single-note pitch/velocity changed: ' + JSON.stringify(parsed.notes[0]));
    return 'PPQ ' + parsed.ppq + ', ' + parsed.bpm.toFixed(3) + ' BPM';
  });

  await check('不等时值音符与三处明显不同休止在 MIDI 后保持', async function () {
    const item = fixtures.unequalRests();
    const parsed = assertMidiRoundTrip(midi.encodeMidi, item.notes, item.bpm, 'unequal-rests');
    const ordered = stableNotes(parsed.notes), gaps = [];
    for (let index = 1; index < ordered.length; index++) {
      gaps.push(ordered[index].start - ordered[index - 1].start - ordered[index - 1].duration);
    }
    const expectedGaps = [0.625, 0.875, 2.5];
    gaps.forEach(function (gap, index) { close(gap, expectedGaps[index], 1 / parsed.ppq + TICK_EPSILON, 'rest ' + index); });
    invariant(gaps[0] !== gaps[1] && gaps[1] !== gaps[2] && gaps[0] !== gaps[2],
      'fixture failed to preserve unequal rests: ' + JSON.stringify(gaps));
    return 'rests ' + gaps.map(function (value) { return value.toFixed(3); }).join('/') + ' beats';
  });

  await check('八度落点与 MIDI 21/108 音域边界可无损往返', async function () {
    const item = fixtures.octaveBoundaries();
    const parsed = assertMidiRoundTrip(midi.encodeMidi, item.notes, item.bpm, 'octave-boundaries');
    const pitches = parsed.notes.map(function (n) { return n.midi; }).sort(function (a, b) { return a - b; });
    assert.deepEqual(pitches, [21, 60, 72, 108]);
    invariant(pitches[2] - pitches[1] === 12, 'octave interval 60→72 was not preserved');
    return 'MIDI 21, 60, 72, 108';
  });

  await check('500 音符恰在上限并可完整导出、独立读回', async function () {
    const item = fixtures.dense500();
    invariant(item.notes.length === 500, 'fixture does not contain 500 notes');
    invariant(new Set(item.notes.map(function (n) { return n.id; })).size === 500, 'dense-500 ids are not unique');
    const parsed = assertMidiRoundTrip(midi.encodeMidi, item.notes, item.bpm, 'dense-500');
    results.metrics.dense500Events = parsed.tracks[0].events;
    return '500 notes, ' + parsed.tracks[0].events + ' track events';
  });

  await check('2 分钟边界按 BPM=40、80 拍严格落在 120.000 秒', async function () {
    const item = fixtures.twoMinuteBoundary();
    assertMidiRoundTrip(midi.encodeMidi, item.notes, item.bpm, 'two-minute-boundary');
    close(music.seconds(item.notes, item.bpm), 120, 1e-12, 'fixture total seconds');
    const parsed = readIndependentMidi(midi.encodeMidi(item.notes, item.bpm), 'two-minute-independent');
    const parsedSeconds = parsed.endTick * 60 / (parsed.bpm * parsed.ppq);
    close(parsedSeconds, 120, 1e-9, 'independent MIDI total seconds');
    return parsedSeconds.toFixed(6) + ' s';
  });

  await check('getOverlaps 边界差分：同起点/嵌套/相接/1e-6/乱序/重复 ID', async function () {
    const cases = [
      { name: 'same-start-unsorted', notes: [
        { id: 'late', midi: 67, start: 0.5, duration: 0.5 },
        { id: 'same-c', midi: 64, start: 0, duration: 1 },
        { id: 'same-a', midi: 60, start: 0, duration: 0.125 }
      ] },
      { name: 'nested', notes: [
        { id: 'inner', midi: 64, start: 1, duration: 1 },
        { id: 'outer', midi: 48, start: 0, duration: 4 },
        { id: 'middle', midi: 60, start: 0.5, duration: 3 }
      ] },
      { name: 'touching-only', notes: [
        { id: 'b', midi: 64, start: 1, duration: 1 },
        { id: 'a', midi: 60, start: 0, duration: 1 },
        { id: 'c', midi: 67, start: 2, duration: 1 }
      ] },
      { name: 'at-1e-6-boundary', notes: [
        { id: 'a', midi: 60, start: 0, duration: 1 },
        { id: 'b', midi: 64, start: 1 - 1e-6, duration: 0.125 }
      ] },
      { name: 'inside-1e-6-boundary', notes: [
        { id: 'a', midi: 60, start: 0, duration: 1 },
        { id: 'b', midi: 64, start: 1 - 1.0001e-6, duration: 0.125 }
      ] },
      { name: 'duplicate-id', notes: [
        { id: 'same-id', midi: 60, start: 1, duration: 1 },
        { id: 'same-id', midi: 64, start: 0, duration: 1 },
        { id: 'same-id', midi: 67, start: 0.5, duration: 1 }
      ] }
    ];
    for (const item of cases) {
      const oracle = overlapsOracle(item.notes), before = clone(item.notes), actual = music.getOverlaps(item.notes);
      assertOverlapMatch(actual, oracle, item);
      invariant(JSON.stringify(item.notes) === JSON.stringify(before), item.name + ': getOverlaps polluted input');
    }
    invariant(overlapsOracle(cases[2].notes).pairCount === 0, 'touching-only case unexpectedly overlaps');
    invariant(overlapsOracle(cases[3].notes).pairCount === 0, 'exact 1e-6 boundary unexpectedly overlaps');
    invariant(overlapsOracle(cases[4].notes).pairCount === 1, 'inside 1e-6 boundary failed to overlap');
    invariant(overlapsOracle(cases[5].notes).ids.length === 1, 'duplicate ids must be deduplicated in ids output');
    return cases.length + ' adversarial cases';
  });

  await check('getOverlaps 与 O(n²) oracle 对固定种子随机有效 notes 差分', async function () {
    const random = fixtures.makeRng(0xc0ffee01);
    let totalNotes = 0, totalPairs = 0;
    for (let caseIndex = 0; caseIndex < 240; caseIndex++) {
      const count = Math.floor(random() * 65), notes = randomValidNotes(random, count);
      notes.forEach(function (item) {
        invariant(item.duration >= 0.125 && item.start >= 0 && item.midi >= 21 && item.midi <= 108,
          'generated invalid note at case ' + caseIndex + ': ' + JSON.stringify(item));
      });
      const oracle = overlapsOracle(notes), before = clone(notes), actual = music.getOverlaps(notes);
      assertOverlapMatch(actual, oracle, { caseIndex, count, notes });
      assert.deepEqual(notes, before, 'case ' + caseIndex + ': getOverlaps mutated source order/objects');
      totalNotes += count; totalPairs += oracle.pairCount;
    }
    results.metrics.randomOverlapCases = 240;
    results.metrics.randomOverlapNotes = totalNotes;
    results.metrics.randomOverlapPairs = totalPairs;
    return '240 sets, ' + totalNotes + ' notes, ' + totalPairs + ' overlapping pairs';
  });

  await check('500 个不同起点、共同终点的全重叠嵌套与 oracle 一致', async function () {
    const item = fixtures.nestedOverlaps();
    invariant(item.notes.length === 500 && item.expectedPairCount === 124750, 'nested fixture bounds changed');
    const oracle = overlapsOracle(item.notes), started = performance.now(), actual = music.getOverlaps(item.notes);
    const elapsed = performance.now() - started;
    assertOverlapMatch(actual, oracle, { fixture: item.name, expectedPairCount: item.expectedPairCount });
    invariant(actual.pairCount === 124750, 'dense overlap pair count changed: ' + actual.pairCount);
    invariant(actual.ids.length === 500, 'dense overlap ids changed: ' + actual.ids.length);
    results.metrics.denseOverlapMs = elapsed;
    return '124750 pairs, 500 ids, observed ' + elapsed.toFixed(3) + ' ms (not a threshold)';
  });

  await check('创作变形可逆且深层冻结的源音符不被污染', async function () {
    const source = deepFreeze(fixtures.knownMelody().notes), before = clone(source);
    const replace = function (preset, extra) {
      return composition.createVariation(source, Object.assign({ preset, mode: 'replace' }, extra || {})).notes;
    };
    const retrograde = replace('retrograde');
    assert.deepEqual(retrograde.map(function (n) { return n.midi; }), [67, 69, 67, 64, 62, 60]);
    const retrogradeTwice = composition.createVariation(retrograde, { preset: 'retrograde', mode: 'replace' }).notes;
    assertMusicalFields(retrogradeTwice, source, 1e-9, 'retrograde twice');

    const inverted = replace('inversion');
    assert.deepEqual(stableNotes(inverted).map(function (n) { return n.midi; }), [60, 58, 56, 53, 51, 53]);
    const inversionTwice = composition.createVariation(inverted, { preset: 'inversion', mode: 'replace' }).notes;
    assertMusicalFields(inversionTwice, source, 1e-9, 'inversion twice');

    const transposed = replace('transpose', { transpose: 5 });
    const transposedBack = composition.createVariation(transposed,
      { preset: 'transpose', mode: 'replace', transpose: -5 }).notes;
    assertMusicalFields(transposedBack, source, 1e-9, 'transpose +5 then -5');
    const orderedSource = stableNotes(source), orderedTransposed = stableNotes(transposed);
    const sourceIntervals = orderedSource.slice(1).map(function (n, i) { return n.midi - orderedSource[i].midi; });
    const movedIntervals = orderedTransposed.slice(1).map(function (n, i) { return n.midi - orderedTransposed[i].midi; });
    assert.deepEqual(movedIntervals, sourceIntervals, 'transpose changed melodic intervals');

    const augmented = replace('augment');
    stableNotes(augmented).forEach(function (item, index) {
      const original = orderedSource[index];
      invariant(item.midi === original.midi, 'augment changed pitch at note ' + index);
      close(item.start, original.start * 2, 1e-9, 'augment start ' + index);
      close(item.duration, original.duration * 2, 1e-9, 'augment duration ' + index);
    });
    const diminishedBack = composition.createVariation(augmented, { preset: 'diminish', mode: 'replace' }).notes;
    assertMusicalFields(diminishedBack, source, 1e-9, 'augment then diminish');

    const retroInverted = replace('retrograde-inversion');
    assert.deepEqual(stableNotes(retroInverted).map(function (n) { return n.midi; }), [53, 51, 53, 56, 58, 60]);
    // With a closed phrase (same first and last pitch), the documented
    // "first-pitch axis" remains valid when retrograde-inversion is repeated.
    const closedPhrase = deepFreeze([
      { id: 'closed-a', midi: 60, start: 0, duration: 0.5, velocity: 80, confidence: 1 },
      { id: 'closed-b', midi: 64, start: 1, duration: 1, velocity: 85, confidence: 1 },
      { id: 'closed-c', midi: 67, start: 2.5, duration: 0.5, velocity: 90, confidence: 1 },
      { id: 'closed-d', midi: 60, start: 3.5, duration: 1, velocity: 95, confidence: 1 }
    ]);
    const retroInvertedClosed = composition.createVariation(closedPhrase,
      { preset: 'retrograde-inversion', mode: 'replace' }).notes;
    const retroInvertedClosedTwice = composition.createVariation(retroInvertedClosed,
      { preset: 'retrograde-inversion', mode: 'replace' }).notes;
    assertMusicalFields(retroInvertedClosedTwice, closedPhrase, 1e-9, 'retrograde-inversion twice (closed phrase)');
    assert.deepEqual(source, before, 'composition mutated the frozen source fixture');
    return 'retrograde/inversion/transpose/augment/retrograde-inversion';
  });

  await check('编辑 moveNote/changeDuration 可恢复且不修改源数组', async function () {
    const source = deepFreeze([
      { id: 'move-a', midi: 60, start: 0.25, duration: 0.5, velocity: 80, confidence: 1 },
      { id: 'move-b', midi: 64, start: 1.5, duration: 0.75, velocity: 90, confidence: 1 },
      { id: 'move-c', midi: 67, start: 3, duration: 1, velocity: 100, confidence: 1 }
    ]);
    const before = clone(source);
    const movedBack = music.moveNote(music.moveNote(source, 'move-b', 2.25, 62), 'move-b', 1.5, 64);
    assertMusicalFields(movedBack, source, 1e-9, 'moveNote inverse');
    const changedBack = music.changeDuration(music.changeDuration(source, 'move-a', 1.125), 'move-a', 0.5);
    assertMusicalFields(changedBack, source, 1e-9, 'changeDuration inverse');
    assert.deepEqual(source, before, 'editor primitive mutated source notes');
    return 'two round-trips';
  });

  await check('超长标题在本机存储与摘要中被有界保存', async function () {
    const item = fixtures.longTitle();
    invariant(item.title.length > 2000, 'long-title fixture is not long enough: ' + item.title.length);
    const memory = new Map(), originalWx = global.wx;
    let savedLength = 0;
    global.wx = {
      env: { USER_DATA_PATH: '/quality-memory-only' },
      getStorageSync: function (key) { return memory.has(key) ? clone(memory.get(key)) : ''; },
      setStorageSync: function (key, value) { memory.set(key, clone(value)); },
      removeStorageSync: function (key) { memory.delete(key); },
      getFileSystemManager: function () { return { mkdirSync: function () {} }; }
    };
    try {
      const saved = storage.save({ id: 'quality-long-title', title: item.title, bpm: item.bpm,
        notes: item.notes, createdAt: 1, updatedAt: 1 });
      invariant(saved.title.length > 0 && saved.title.length <= 40,
        'saved title is not bounded: length=' + saved.title.length);
      invariant(item.title.startsWith(saved.title), 'saved title is not a prefix of source title');
      invariant(saved.title === storage.get('quality-long-title').title, 'saved and fetched titles differ');
      invariant(saved.title === storage.summaryPage(0, 10).items[0].title, 'summary title differs from saved title');
      savedLength = saved.title.length;
      invariant(!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(^|[^\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(saved.title),
        'saved title contains an unmatched UTF-16 surrogate: ' + JSON.stringify(saved.title));
    } finally { global.wx = originalWx; }
    return item.title.length + ' source code units -> ' + savedLength + ' persisted';
  });

  await check('静音/噪声/谐波颤音在 8k/16k/44.1k/48k 保持类别特征', async function () {
    for (const rate of fixtures.SAMPLE_RATES) {
      const silence = fixtures.audioSilence(rate), noise = fixtures.audioNoise(rate);
      const harmonic = fixtures.audioHarmonicVibrato(rate);
      invariant(silence.samples.length === Math.round(silence.duration * rate), rate + ': silence length mismatch');
      invariant(silence.samples.every(function (value) { return value === 0; }), rate + ': silence has nonzero samples');
      invariant(noise.samples.every(Number.isFinite), rate + ': noise contains non-finite sample');
      invariant(harmonic.samples.every(Number.isFinite), rate + ': harmonic audio contains non-finite sample');
      let noisePower = 0, harmonicPower = 0, noisePeak = 0, harmonicPeak = 0;
      for (let index = 0; index < noise.samples.length; index++) {
        const n = noise.samples[index]; noisePower += n * n; noisePeak = Math.max(noisePeak, Math.abs(n));
      }
      for (let index = 0; index < harmonic.samples.length; index++) {
        const n = harmonic.samples[index]; harmonicPower += n * n; harmonicPeak = Math.max(harmonicPeak, Math.abs(n));
      }
      const noiseRms = Math.sqrt(noisePower / noise.samples.length);
      const harmonicRms = Math.sqrt(harmonicPower / harmonic.samples.length);
      invariant(noiseRms > 0.001 && noisePeak < 0.05, rate + ': noise statistics invalid');
      invariant(harmonicRms > noiseRms * 5, rate + ': harmonic fixture lacks musical energy over noise');
      invariant(harmonicPeak < 0.95, rate + ': harmonic fixture exceeds safe peak');
    }
    return fixtures.SAMPLE_RATES.join('/') + ' Hz';
  });

  await check('WAV 采样率往返 + 合成已知旋律识别 + MIDI 端到端（仅合成语料）', async function () {
    const item = fixtures.knownMelody(), expectations = [];
    for (const rate of fixtures.SAMPLE_RATES) {
      const generated = fixtures.audioHarmonicVibrato(rate);
      const decoded = wav.decodeWav(wav.encodeWav(generated.samples, rate));
      invariant(decoded && decoded.sampleRate === rate, rate + ': WAV sample rate was not preserved');
      let maxError = 0;
      for (let index = 0; index < generated.samples.length; index++) {
        maxError = Math.max(maxError, Math.abs(generated.samples[index] - decoded.samples[index]));
      }
      invariant(maxError < 4e-5, rate + ': WAV quantization error ' + maxError + ' is too large');

      const result = await pitch.transcribe(decoded.samples, decoded.sampleRate, item.bpm);
      const detected = stableNotes(result.notes);
      invariant(detected.length >= 5 && detected.length <= 7,
        rate + ': synthetic melody produced implausible note count ' + detected.length + ': ' + JSON.stringify(detected));
      let cursor = 0;
      const matches = [];
      item.pitches.forEach(function (expectedPitch, expectedIndex) {
        const expectedOnset = generated.lead + expectedIndex * (generated.noteSeconds + generated.gap);
        let best = null;
        for (let index = cursor; index < detected.length; index++) {
          const actual = detected[index], onset = actual.start * 60 / item.bpm;
          const pitchError = Math.abs(actual.midi - expectedPitch), onsetError = Math.abs(onset - expectedOnset);
          if (pitchError <= 0.65 && onsetError <= 0.12 && (!best || pitchError + onsetError < best.pitchError + best.onsetError)) {
            best = { index, actual, onset, onsetError, pitchError, durationSeconds: actual.duration * 60 / item.bpm };
          }
        }
        if (best) { cursor = best.index + 1; matches.push({ expectedPitch, expectedIndex, expectedOnset, actual: best }); }
      });
      invariant(matches.length >= 5, rate + ': synthetic melody matched only ' + matches.length + '/6 notes: detected=' +
        JSON.stringify(detected) + ', pitches=' + JSON.stringify(item.pitches));
      const pitchErrors = matches.map(function (match) { return match.actual.pitchError; }).sort(function (a, b) { return a - b; });
      const onsetErrors = matches.map(function (match) { return match.actual.onsetError; }).sort(function (a, b) { return a - b; });
      const medianPitchError = pitchErrors[Math.floor(pitchErrors.length / 2)];
      const medianOnsetError = onsetErrors[Math.floor(onsetErrors.length / 2)];
      invariant(medianPitchError <= 0.25, rate + ': median synthetic pitch error ' + medianPitchError);
      invariant(medianOnsetError <= 0.08, rate + ': median synthetic onset error ' + medianOnsetError);
      matches.forEach(function (match) {
        invariant(Math.abs(match.actual.durationSeconds - generated.noteSeconds) <= 0.14,
          rate + ': synthetic note duration is implausible: ' + JSON.stringify(match));
      });
      invariant(result.confidence > 0.85, rate + ': synthetic melody confidence unexpectedly low: ' + result.confidence);
      const midiParsed = assertMidiRoundTrip(midi.encodeMidi, result.notes, item.bpm, 'recognized-' + rate);
      invariant(midiParsed.notes.length === result.notes.length, rate + ': recognized notes lost in MIDI export');
      expectations.push(rate + ':' + matches.length + '/6');
      results.metrics['recognition' + rate] = { matched: matches.length, detected: detected.length,
        medianPitchError, medianOnsetError, confidence: result.confidence };
    }
    return expectations.join(', ') + ' (synthetic only; no human-accuracy claim)';
  });

  await check('纯静音与确定性噪声在四种采样率下都不会伪造旋律', async function () {
    for (const rate of fixtures.SAMPLE_RATES) {
      for (const name of ['audio-silence', 'audio-noise']) {
        const item = fixtures.getFixture(name, { sampleRate: rate });
        let unexpected = null;
        try { unexpected = await pitch.transcribe(item.samples, rate, 96); }
        catch (error) {
          assert.match(error.message, /没有找到稳定的旋律/,
            rate + ' Hz ' + name + ': unexpected rejection message: ' + error.message);
        }
        invariant(unexpected == null, rate + ' Hz ' + name + ' produced false notes: ' +
          JSON.stringify(unexpected && unexpected.notes));
      }
    }
    return fixtures.SAMPLE_RATES.join('/') + ' Hz';
  });

  results.total = results.passed + results.failed;
  log('');
  log('Quality round: ' + results.passed + '/' + results.total + ' checks passed' +
    (results.failed ? ', ' + results.failed + ' failed.' : '.'));
  log('Target: ' + results.root);
  if (results.metrics.randomOverlapCases) {
    log('Overlap differential: ' + results.metrics.randomOverlapCases + ' random sets, ' +
      results.metrics.randomOverlapNotes + ' notes, ' + results.metrics.randomOverlapPairs + ' pairs; ' +
      'dense500=' + results.metrics.denseOverlapMs.toFixed(3) + ' ms (informational).');
  }
  if (results.failed) log('Failure counterexamples are included above. No production files were modified.');
  return results;
}

function parseCli(argv) {
  const parsed = { root: DEFAULT_ROOT };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === '--root') parsed.root = path.resolve(argv[++index] || '');
    else if (arg.startsWith('--root=')) parsed.root = path.resolve(arg.slice(7));
    else if (arg === '--help' || arg === '-h') parsed.help = true;
    else throw new Error('unknown argument: ' + arg);
  }
  return parsed;
}

async function main(argv) {
  const args = parseCli(argv || process.argv.slice(2));
  if (args.help) {
    process.stdout.write('Usage: node tests/quality-round.cjs [--root <project-root>]\n');
    return 0;
  }
  const result = await run({ root: args.root, log: console.log });
  return result.failed ? 1 : 0;
}

module.exports = { run, readIndependentMidi, overlapsOracle };

if (require.main === module) {
  main().then(function (code) { process.exitCode = code; }).catch(function (error) {
    console.error(error && error.stack || error);
    process.exitCode = 1;
  });
}
