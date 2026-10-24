'use strict';

const assert = require('assert');
const current = require('../miniprogram/utils/pitch.js');
const baseline = require('../tools/performance-baseline/pitch.js');

const BENCHMARK = process.argv.includes('--benchmark');
const RATES = [4000, 8000, 16000];
const WORK_SIZE = 205;
const FRAME_SIZE = 512;
const results = { comparisons: 0, voiced: 0, nullPitch: 0, complete: 0, padded: 0 };

function rng(seed) {
  let state = seed >>> 0;
  return function next() {
    state = (state + 0x6D2B79F5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function maxTau(rate) {
  return Math.min(WORK_SIZE - 2, Math.ceil(rate / 40));
}

function frequencyFromMidi(midi) {
  return midi == null ? null : 440 * Math.pow(2, (midi - 69) / 12);
}

function sameNumber(actual, expected, label) {
  assert.ok(Object.is(actual, expected), label + ': ' + actual + ' !== ' + expected);
}


function assertYinEqual(samples, offset, rate, gate, label) {
  const before = baseline.yin(samples, offset, rate, gate, new Float32Array(WORK_SIZE));
  const after = current.yin(samples, offset, rate, gate, new Float32Array(WORK_SIZE));
  sameNumber(after.midi, before.midi, label + ' midi');
  sameNumber(frequencyFromMidi(after.midi), frequencyFromMidi(before.midi), label + ' frequency');
  sameNumber(after.confidence, before.confidence, label + ' confidence');
  sameNumber(after.rms, before.rms, label + ' rms');
  results.comparisons++;
  if (after.midi == null) results.nullPitch++; else results.voiced++;
  const complete = samples instanceof Float32Array && offset >= 0 && offset + FRAME_SIZE + maxTau(rate) < samples.length;
  if (complete) results.complete++; else results.padded++;
  return after;
}

function synthFrame(kind, rate, seed, offset, length) {
  const out = new Float32Array(length);
  const random = rng(seed);
  const base = [39.75, 40, 40.25, 55, 82.41, 110, 220, 329.63, 440, 880, 1399.75, 1400, 1400.25][seed % 13];
  let phase = 0;
  for (let i = offset; i < length; i++) {
    const t = (i - offset) / rate;
    let value;
    if (kind === 'silence') value = 0;
    else if (kind === 'dc') value = seed % 2 ? .15 : -.08;
    else if (kind === 'low-noise') value = .0004 + (random() - .5) * .0006;
    else if (kind === 'unvoiced') value = (random() - .5) * .35;
    else if (kind === 'random') value = (random() - .5) * 1.5;
    else {
      const vibrato = kind === 'vibrato' ? 1 + .022 * Math.sin(2 * Math.PI * 5.4 * t) : 1;
      phase += 2 * Math.PI * base * vibrato / rate;
      if (kind === 'vibrato') value = .19 * Math.sin(phase + .18 * Math.sin(2 * Math.PI * 5.4 * t)) + .055 * Math.sin(phase * 2) + .02 * Math.sin(phase * 3);
      else if (kind === 'boundary') value = .2 * Math.sin(phase) + .06 * Math.sin(phase * 2) + .025 * Math.sin(phase * 3);
      else value = .22 * Math.sin(phase) + .09 * Math.sin(phase * 2.01) + .035 * Math.sin(phase * 3.02);
    }
    out[i] = value;
  }
  return out;
}

function testFrames() {
  const kinds = ['silence', 'dc', 'low-noise', 'unvoiced', 'harmonic', 'vibrato', 'boundary', 'random'];
  for (const rate of RATES) {
    let ordinal = 0;
    for (const kind of kinds) {
      for (let frame = 0; frame < 96; frame++, ordinal++) {
        const offset = (frame * 17 + ordinal * 3) % 100;
        const samples = synthFrame(kind, rate, rate + ordinal * 7919, offset, 1200);
        assertYinEqual(samples, offset, rate, 0.001, rate + 'Hz/' + kind + '/' + frame);
      }
    }
    for (let frame = 0; frame < 72; frame++) {
      const offset = 29 + (frame % 19);
      const full = synthFrame(frame % 3 ? 'harmonic' : 'random', rate, rate + frame * 104729, offset, 1200);
      const lengths = [
        offset + FRAME_SIZE - 1,
        offset + FRAME_SIZE + Math.floor(maxTau(rate) / 2),
        offset + FRAME_SIZE + maxTau(rate) - 1,
        offset + FRAME_SIZE + maxTau(rate),
        FRAME_SIZE,
        600
      ];
      const samples = full.slice(0, lengths[frame % lengths.length]);
      assertYinEqual(samples, offset, rate, 0, rate + 'Hz/tail/' + frame);
    }
    for (let frame = 0; frame < 64; frame++) {
      const length = [0, 1, 7, 31, 100, 511, 512, 513, 600, 700][frame % 10];
      const samples = synthFrame(frame % 2 ? 'harmonic' : 'unvoiced', rate, rate + frame * 65537, 0, length);
      const offsets = [0, -1, 1, 13, 511, 700];
      assertYinEqual(samples, offsets[frame % offsets.length], rate, 0, rate + 'Hz/short/' + frame);
    }
  }
}

function frequency(midi) {
  return 440 * Math.pow(2, (midi - 69) / 12);
}

function synthHum(rate, options) {
  const settings = options || {};
  const notes = settings.notes || [57, 60, 64, 67, 64, 60];
  const noteSeconds = settings.noteSeconds || .58;
  const gapSeconds = settings.gapSeconds || .12;
  const total = notes.length * (noteSeconds + gapSeconds) + .12;
  const out = new Float32Array(Math.ceil(total * rate));
  const random = rng(settings.seed || 0x51F15E);
  for (let n = 0; n < notes.length; n++) {
    const begin = Math.round((.08 + n * (noteSeconds + gapSeconds)) * rate);
    const end = Math.min(out.length, begin + Math.round(noteSeconds * rate));
    let phase = 0;
    for (let i = begin; i < end; i++) {
      const t = (i - begin) / rate;
      const hz = frequency(notes[n]) * (1 + .008 * Math.sin(2 * Math.PI * 5.1 * t));
      phase += 2 * Math.PI * hz / rate;
      out[i] = .23 * Math.sin(phase) + .075 * Math.sin(2 * phase) + .03 * Math.sin(3 * phase) + (random() - .5) * .006;
    }
  }
  return out;
}

function comparableNotes(notes) {
  return notes.map(note => ({
    midi: note.midi,
    start: note.start,
    duration: note.duration,
    velocity: note.velocity,
    confidence: note.confidence
  }));
}

function assertSameNotes(actual, expected, label) {
  assert.strictEqual(actual.length, expected.length, label + ' note count');
  for (let i = 0; i < actual.length; i++) {
    const a = actual[i], b = expected[i];
    sameNumber(a.midi, b.midi, label + ' note ' + i + ' midi');
    sameNumber(a.start, b.start, label + ' note ' + i + ' start');
    sameNumber(a.duration, b.duration, label + ' note ' + i + ' duration');
    sameNumber(a.velocity, b.velocity, label + ' note ' + i + ' velocity');
    sameNumber(a.confidence, b.confidence, label + ' note ' + i + ' confidence');
  }
}

async function transcribeOne(impl, signal, rate, label) {
  const progress = [];
  const value = await impl.transcribe(signal, rate, 100, p => progress.push(p));
  assert.strictEqual(progress.at(-1), 100, label + ' final progress');
  assert.ok(progress.every((p, i) => i === 0 || p > progress[i - 1]), label + ' progress monotonic');
  return value;
}

async function testTranscribe() {
  for (const rate of RATES) {
    const signal = synthHum(rate, { seed: 9000 + rate });
    const before = await transcribeOne(baseline, signal, rate, 'baseline/' + rate);
    const after = await transcribeOne(current, signal, rate, 'current/' + rate);
    sameNumber(after.duration, before.duration, rate + ' duration');
    sameNumber(after.confidence, before.confidence, rate + ' transcribe confidence');
    assertSameNotes(comparableNotes(after.notes), comparableNotes(before.notes), rate + ' transcribe');
    assert.ok(after.notes.length >= 4, rate + ' expected melody notes');
  }
  const quiet = new Float32Array(16000).fill(.05);
  let beforeError = null, afterError = null;
  try { await baseline.transcribe(quiet, 16000, 100); } catch (error) { beforeError = error; }
  try { await current.transcribe(quiet, 16000, 100); } catch (error) { afterError = error; }
  assert.ok(beforeError && afterError);
  assert.strictEqual(afterError.message, beforeError.message);
}

function median(values) {
  const ordered = values.slice().sort((a, b) => a - b);
  return ordered[Math.floor(ordered.length / 2)];
}

function elapsedMs(start) {
  return Number(process.hrtime.bigint() - start) / 1e6;
}

function makeBenchFrames(count) {
  const frames = [];
  for (let i = 0; i < count; i++) {
    const kind = i % 5 === 0 ? 'unvoiced' : (i % 11 === 0 ? 'vibrato' : 'harmonic');
    frames.push({ samples: synthFrame(kind, 8000, 0xABC000 + i * 3571, 23, 820), offset: 23 });
  }
  return frames;
}

function runYin(impl, frames) {
  const work = new Float32Array(WORK_SIZE);
  const start = process.hrtime.bigint();
  let checksum = 0;
  for (let i = 0; i < frames.length; i++) {
    const item = frames[i];
    const value = impl.yin(item.samples, item.offset, 8000, .001, work);
    checksum += value.midi == null ? value.rms : value.midi + value.confidence + value.rms;
  }
  return { ms: elapsedMs(start), checksum };
}

function runYinRounds(impl, frames, rounds) {
  for (let i = 0; i < 2; i++) runYin(impl, frames);
  const values = [];
  let checksum = null;
  for (let i = 0; i < rounds; i++) {
    const run = runYin(impl, frames);
    values.push(run.ms);
    checksum = run.checksum;
  }
  return { medianMs: median(values), checksum };
}

// Same melody fixture and default settings as tests/run.js, plus the third
// harmonic and lead noise used by the 30-second end-to-end regression.
function synthThirtySeconds(rate) {
  const pitches = Array.from({ length: 40 }, (_, i) => [60, 64, 67, 69][i % 4]);
  const options = { seconds: .6, gap: .13, lead: .15, noise: .002, vibrato: .12, dc: 0 };
  const duration = options.lead + pitches.length * (options.seconds + options.gap) + .15;
  const samples = new Float32Array(Math.ceil(duration * rate));
  let seed = 91;
  for (let i = 0; i < samples.length; i++) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    samples[i] = (seed / 4294967296 * 2 - 1) * options.noise + options.dc;
  }
  pitches.forEach((midi, index) => {
    const first = Math.round((options.lead + index * (options.seconds + options.gap)) * rate);
    let phase = 0;
    for (let i = 0; i < Math.round(options.seconds * rate); i++) {
      const t = i / rate, hz = frequency(midi + options.vibrato * Math.sin(2 * Math.PI * 5 * t));
      phase += 2 * Math.PI * hz / rate;
      const envelope = Math.min(1, t / .025, (options.seconds - t) / .03);
      samples[first + i] += envelope * .35 * (Math.sin(phase) + .35 * Math.sin(2 * phase) + .12 * Math.sin(3 * phase));
    }
  });
  return samples;
}

async function timeTranscribe(impl, signal, rate, rounds) {
  await impl.transcribe(signal, rate, 100);
  const values = [];
  let noteCount = 0;
  for (let i = 0; i < rounds; i++) {
    const start = process.hrtime.bigint();
    const result = await impl.transcribe(signal, rate, 100);
    values.push(Number(process.hrtime.bigint() - start) / 1e6);
    noteCount = result.notes.length;
  }
  return { medianMs: median(values), noteCount };
}

async function benchmark() {
  const frames = makeBenchFrames(600);
  const before = runYinRounds(baseline, frames, 7);
  const after = runYinRounds(current, frames, 7);
  sameNumber(after.checksum, before.checksum, 'benchmark checksum');

  const signal = synthHum(8000, { seed: 0x7A11, noteSeconds: .62, gapSeconds: .1 });
  const beforeTranscribe = await timeTranscribe(baseline, signal, 8000, 5);
  const afterTranscribe = await timeTranscribe(current, signal, 8000, 5);
  assert.strictEqual(afterTranscribe.noteCount, beforeTranscribe.noteCount);

  const longSignal = synthThirtySeconds(16000);
  const beforeLong = await timeTranscribe(baseline, longSignal, 16000, 5);
  const afterLong = await timeTranscribe(current, longSignal, 16000, 5);
  assert.strictEqual(afterLong.noteCount, beforeLong.noteCount);

  const report = {
    runtime: process.version,
    platform: process.platform + '/' + process.arch,
    rounds: { yin: 7, shortTranscribe: 5, thirtySecondTranscribe: 5 },
    yin600Frames8k: { baselineMs: before.medianMs, currentMs: after.medianMs },
    shortTranscribe8k: { samples: signal.length, baselineMs: beforeTranscribe.medianMs, currentMs: afterTranscribe.medianMs },
    thirtySecondTranscribe16k: { samples: longSignal.length, seconds: longSignal.length / 16000, notes: afterLong.noteCount, baselineMs: beforeLong.medianMs, currentMs: afterLong.medianMs },
    caveat: 'Desktop Node only; this is not phone performance.'
  };
  console.log('BENCH ' + JSON.stringify(report));
  return report;
}

(async function main() {
  testFrames();
  await testTranscribe();
  console.log('PASS YIN exact: ' + results.comparisons + ' frames, voiced=' + results.voiced + ', null=' + results.nullPitch + ', complete=' + results.complete + ', padded=' + results.padded);
  console.log('PASS transcribe exact at 4/8/16k; durations, notes, velocity, confidence match');
  if (BENCHMARK) await benchmark();
})().catch(error => { console.error(error); process.exitCode = 1; });
