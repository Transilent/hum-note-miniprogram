'use strict';

// Deterministic, dependency-free fixtures for quality and stress tests.
// Requiring this module has no filesystem, process, or timer side effects.

const crypto = require('node:crypto');

const DEFAULT_SEED = 0x51a7c0de;
const SAMPLE_RATES = Object.freeze([8000, 16000, 44100, 48000]);
const KNOWN_MELODY = Object.freeze([60, 62, 64, 67, 69, 67]);
const LONG_TITLE = '雨后的长街' + '回声'.repeat(1024) + '终章🎵';

const FIXTURE_NAMES = Object.freeze([
  'single-note',
  'unequal-rests',
  'octave-boundaries',
  'dense-500',
  'two-minute-boundary',
  'nested-overlaps',
  'long-title',
  'known-melody',
  'audio-silence',
  'audio-noise',
  'audio-harmonic-vibrato'
]);

function note(id, midi, start, duration, velocity, confidence) {
  return {
    id,
    midi,
    start,
    duration,
    velocity: velocity == null ? 88 : velocity,
    confidence: confidence == null ? 1 : confidence
  };
}

function makeRng(seed) {
  let state = seed >>> 0;
  return function next() {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function validateSampleRate(sampleRate) {
  if (!Number.isFinite(sampleRate) || sampleRate < 4000 || sampleRate > 192000) {
    throw new RangeError('sampleRate must be a finite number from 4000 through 192000');
  }
  return Math.round(sampleRate);
}

function singleNote() {
  return {
    name: 'single-note',
    title: '单个长音 A4',
    bpm: 96,
    seed: DEFAULT_SEED,
    notes: [note('single-a4', 69, 0, 2.5, 93, 0.97)]
  };
}

function unequalRests() {
  return {
    name: 'unequal-rests',
    title: '不等时值与四处呼吸',
    bpm: 90,
    seed: DEFAULT_SEED,
    notes: [
      note('rest-a', 60, 0, 0.375, 80),
      note('rest-b', 64, 1, 1.125, 91),
      note('rest-c', 67, 3, 0.25, 76),
      note('rest-d', 69, 5.75, 2.5, 104)
    ]
  };
}

function octaveBoundaries() {
  return {
    name: 'octave-boundaries',
    title: '八度与全音域边界',
    bpm: 108,
    seed: DEFAULT_SEED,
    notes: [
      note('range-min', 21, 0, 0.5, 64),
      note('range-c4', 60, 1, 0.5, 82),
      note('range-c5', 72, 2, 0.5, 96),
      note('range-max', 108, 3, 0.5, 118)
    ]
  };
}

function dense500() {
  const pitches = [60, 64, 67, 72];
  return {
    name: 'dense-500',
    title: '五百音符密集琶音',
    bpm: 240,
    seed: DEFAULT_SEED,
    notes: Array.from({ length: 500 }, function (_, index) {
      return note('dense-' + String(index).padStart(3, '0'), pitches[index % pitches.length],
        index * 0.125, 0.125, 70 + (index % 24), 1);
    })
  };
}

function twoMinuteBoundary() {
  return {
    name: 'two-minute-boundary',
    title: '恰好两分钟的慢速长音',
    bpm: 40,
    seed: DEFAULT_SEED,
    seconds: 120,
    notes: [
      note('minute-1', 48, 0, 16, 72),
      note('minute-2', 55, 16, 16, 82),
      note('minute-3', 60, 32, 16, 92),
      note('minute-4', 64, 48, 16, 102),
      note('minute-5', 67, 64, 16, 110)
    ]
  };
}

function nestedOverlaps() {
  const count = 500;
  return {
    name: 'nested-overlaps',
    title: '五百音共终点全重叠',
    bpm: 120,
    seed: DEFAULT_SEED,
    expectedPairCount: count * (count - 1) / 2,
    notes: Array.from({ length: count }, function (_, index) {
      const start = Math.round(index * 0.01 * 1000) / 1000;
      return note('nested-' + String(index).padStart(3, '0'), 48 + (index % 25), start, 6 - start, 84);
    })
  };
}

function longTitle() {
  return {
    name: 'long-title',
    title: LONG_TITLE,
    bpm: 100,
    seed: DEFAULT_SEED,
    notes: [note('long-title-note', 60, 0, 1, 86)]
  };
}

function knownMelody() {
  return {
    name: 'known-melody',
    title: '合成已知旋律 C-D-E-G-A-G',
    bpm: 96,
    seed: DEFAULT_SEED,
    pitches: KNOWN_MELODY.slice(),
    notes: [
      note('melody-c4', 60, 0, 0.75, 80),
      note('melody-d4', 62, 1, 0.5, 84),
      note('melody-e4', 64, 2, 0.75, 88),
      note('melody-g4', 67, 3, 1, 94),
      note('melody-a4', 69, 4.5, 0.5, 98),
      note('melody-g4-return', 67, 5.5, 1, 90)
    ]
  };
}

function durationOf(options) {
  const duration = options.duration == null ? 0.9 : Number(options.duration);
  if (!Number.isFinite(duration) || duration < 0.25 || duration > 30) {
    throw new RangeError('duration must be a finite number from 0.25 through 30 seconds');
  }
  return duration;
}

function audioSilence(sampleRate, options) {
  const rate = validateSampleRate(sampleRate);
  const duration = durationOf(options || {});
  return {
    name: 'audio-silence',
    kind: 'silence',
    sampleRate: rate,
    duration,
    samples: new Float32Array(Math.round(duration * rate))
  };
}

function audioNoise(sampleRate, options) {
  const opts = options || {};
  const rate = validateSampleRate(sampleRate);
  const duration = durationOf(opts);
  const seed = Number.isFinite(opts.seed) ? opts.seed >>> 0 : DEFAULT_SEED;
  const amplitude = opts.amplitude == null ? 0.012 : Number(opts.amplitude);
  if (!Number.isFinite(amplitude) || amplitude <= 0 || amplitude >= 0.5) {
    throw new RangeError('amplitude must be greater than 0 and less than 0.5');
  }
  const random = makeRng(seed);
  const samples = new Float32Array(Math.round(duration * rate));
  for (let index = 0; index < samples.length; index++) {
    const white = random() * 2 - 1;
    const roughness = Math.sin(index * 2.399963229728653) * 0.18;
    samples[index] = amplitude * (white + roughness * white * white);
  }
  return { name: 'audio-noise', kind: 'noise', sampleRate: rate, duration, seed, samples };
}

function audioHarmonicVibrato(sampleRate, options) {
  const opts = options || {};
  const rate = validateSampleRate(sampleRate);
  const lead = opts.lead == null ? 0.18 : Number(opts.lead);
  const noteSeconds = opts.noteSeconds == null ? 0.38 : Number(opts.noteSeconds);
  const gap = opts.gap == null ? 0.12 : Number(opts.gap);
  const tail = opts.tail == null ? 0.18 : Number(opts.tail);
  const vibratoDepth = opts.vibratoDepth == null ? 0.1 : Number(opts.vibratoDepth);
  const noiseAmplitude = opts.noiseAmplitude == null ? 0.0012 : Number(opts.noiseAmplitude);
  const pitches = Array.isArray(opts.pitches) ? opts.pitches.slice() : KNOWN_MELODY.slice();
  if (!pitches.length || pitches.some(function (pitch) { return !Number.isFinite(pitch) || pitch < 21 || pitch > 108; })) {
    throw new TypeError('pitches must contain at least one MIDI pitch from 21 through 108');
  }
  if (![lead, noteSeconds, gap, tail, vibratoDepth, noiseAmplitude].every(Number.isFinite) ||
      lead < 0 || noteSeconds < 0.25 || gap < 0 || tail < 0 || vibratoDepth < 0 || vibratoDepth > 1 ||
      noiseAmplitude < 0 || noiseAmplitude >= 0.2) {
    throw new RangeError('invalid harmonic-vibrato audio options');
  }

  const duration = lead + pitches.length * (noteSeconds + gap) + tail;
  const samples = new Float32Array(Math.ceil(duration * rate));
  const random = makeRng(Number.isFinite(opts.seed) ? opts.seed >>> 0 : DEFAULT_SEED);
  for (let index = 0; index < samples.length; index++) {
    samples[index] = (random() * 2 - 1) * noiseAmplitude;
  }

  pitches.forEach(function (midi, noteIndex) {
    const first = Math.round((lead + noteIndex * (noteSeconds + gap)) * rate);
    const last = Math.min(samples.length, first + Math.round(noteSeconds * rate));
    let phase = noteIndex * 0.17;
    for (let index = first; index < last; index++) {
      const local = (index - first) / rate;
      const vibrato = vibratoDepth * Math.sin(2 * Math.PI * 5.1 * local + noteIndex * 0.31);
      const hz = 440 * Math.pow(2, (midi + vibrato - 69) / 12);
      phase += 2 * Math.PI * hz / rate;
      const attack = Math.min(1, local / 0.025);
      const release = Math.min(1, Math.max(0, (last - index) / Math.max(1, Math.round(0.045 * rate))));
      const envelope = attack * release * (0.94 + 0.06 * Math.sin(2 * Math.PI * 2.2 * local));
      const tone = Math.sin(phase) + 0.3 * Math.sin(2 * phase + 0.21) + 0.12 * Math.sin(3 * phase - 0.43);
      samples[index] += 0.27 * envelope * tone;
    }
  });

  for (let index = 0; index < samples.length; index++) {
    samples[index] = Math.max(-0.95, Math.min(0.95, samples[index]));
  }
  return {
    name: 'audio-harmonic-vibrato',
    kind: 'harmonic-vibrato',
    sampleRate: rate,
    duration,
    lead,
    noteSeconds,
    gap,
    tail,
    vibratoDepth,
    noiseAmplitude,
    pitches,
    samples
  };
}

function audioSet(sampleRate, options) {
  const opts = options || {};
  return {
    silence: audioSilence(sampleRate, opts),
    noise: audioNoise(sampleRate, opts),
    'harmonic-vibrato': audioHarmonicVibrato(sampleRate, opts)
  };
}

function getFixture(name, options) {
  const opts = options || {};
  const rate = opts.sampleRate == null ? opts.rate : opts.sampleRate;
  switch (name) {
    case 'single-note': return singleNote();
    case 'unequal-rests': return unequalRests();
    case 'octave-boundaries': return octaveBoundaries();
    case 'dense-500': return dense500();
    case 'two-minute-boundary': return twoMinuteBoundary();
    case 'nested-overlaps': return nestedOverlaps();
    case 'long-title': return longTitle();
    case 'known-melody': return knownMelody();
    case 'audio-silence': return audioSilence(rate == null ? 16000 : rate, opts);
    case 'audio-noise': return audioNoise(rate == null ? 16000 : rate, opts);
    case 'audio-harmonic-vibrato': return audioHarmonicVibrato(rate == null ? 16000 : rate, opts);
    default: throw new RangeError('unknown quality fixture: ' + name);
  }
}

function sha256Json(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function audioStats(fixture) {
  let peak = 0;
  let power = 0;
  for (let index = 0; index < fixture.samples.length; index++) {
    const value = fixture.samples[index];
    peak = Math.max(peak, Math.abs(value));
    power += value * value;
  }
  return {
    peak: Math.round(peak * 1e9) / 1e9,
    rms: Math.round(Math.sqrt(power / Math.max(1, fixture.samples.length)) * 1e9) / 1e9
  };
}

function describeFixture(name, options) {
  const fixture = getFixture(name, options);
  if (fixture.samples instanceof Float32Array) {
    const stats = audioStats(fixture);
    return {
      name: fixture.name,
      type: 'audio',
      kind: fixture.kind,
      sampleRate: fixture.sampleRate,
      duration: fixture.duration,
      sampleCount: fixture.samples.length,
      rms: stats.rms,
      peak: stats.peak,
      sampleSha256: crypto.createHash('sha256')
        .update(Buffer.from(fixture.samples.buffer, fixture.samples.byteOffset, fixture.samples.byteLength))
        .digest('hex')
    };
  }
  const end = fixture.notes.reduce(function (latest, item) {
    return Math.max(latest, item.start + item.duration);
  }, 0);
  return {
    name: fixture.name,
    type: 'notes',
    bpm: fixture.bpm,
    noteCount: fixture.notes.length,
    totalBeats: end,
    durationSeconds: end * 60 / fixture.bpm,
    titleLength: Array.from(fixture.title).length,
    notesSha256: sha256Json(fixture.notes)
  };
}

function parseCli(args) {
  const parsed = { command: 'list', rate: 16000, json: false, full: false };
  const positional = [];
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === '--json') parsed.json = true;
    else if (arg === '--full' || arg === '--samples') parsed.full = true;
    else if (arg === '--rate' || arg === '--sample-rate') {
      parsed.rate = Number(args[++index]);
    } else if (arg.startsWith('--rate=')) parsed.rate = Number(arg.slice(7));
    else if (arg.startsWith('--sample-rate=')) parsed.rate = Number(arg.slice(14));
    else if (arg === '--seed') parsed.seed = Number(args[++index]) >>> 0;
    else if (arg === '--help' || arg === '-h') parsed.command = 'help';
    else positional.push(arg);
  }
  if (positional.length) parsed.command = positional[0];
  return parsed;
}

function main(argv) {
  const args = parseCli(argv || process.argv.slice(2));
  if (args.command === 'help') {
    process.stdout.write('Usage: node tools/quality-fixtures.cjs [list|<fixture>] [--rate 48000] [--seed N] [--json] [--full]\n');
    return;
  }
  if (args.command === 'list') {
    const value = FIXTURE_NAMES.map(function (name) { return describeFixture(name, { sampleRate: 16000 }); });
    process.stdout.write(JSON.stringify(value, null, 2) + '\n');
    return;
  }
  const options = { sampleRate: args.rate, seed: args.seed };
  let value = args.full ? getFixture(args.command, options) : describeFixture(args.command, options);
  if (args.full && value.samples instanceof Float32Array) {
    value = Object.assign({}, value, { samples: Array.from(value.samples) });
  }
  process.stdout.write(JSON.stringify(value, null, args.json ? 0 : 2) + '\n');
}

module.exports = {
  DEFAULT_SEED,
  SAMPLE_RATES,
  KNOWN_MELODY,
  LONG_TITLE,
  FIXTURE_NAMES,
  note,
  makeRng,
  singleNote,
  unequalRests,
  octaveBoundaries,
  dense500,
  twoMinuteBoundary,
  nestedOverlaps,
  longTitle,
  knownMelody,
  audioSilence,
  audioNoise,
  audioHarmonicVibrato,
  audioSet,
  getFixture,
  describeFixture,
  main
};

if (require.main === module) {
  try { main(); }
  catch (error) { console.error(error && error.stack || error); process.exitCode = 1; }
}
