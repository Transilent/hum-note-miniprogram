// Offline HumTrans feature cache and evaluation driver. No dataset files are changed.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { Worker, isMainThread, parentPort, workerData } = require('node:worker_threads');
const { performance } = require('node:perf_hooks');
const { decodeWav } = require('../miniprogram/utils/wav');
const baseline = require('./baseline/pitch');

function csv(text) {
  const rows = []; let row = [], field = '', quoted = false;
  text = text.replace(/^\uFEFF/, '');
  for (let i = 0; i <= text.length; i++) {
    const c = text[i];
    if (c === '"') { if (quoted && text[i + 1] === '"') { field += '"'; i++; } else quoted = !quoted; }
    else if (!quoted && (c === ',' || c === '\n' || c === undefined)) {
      row.push(field.replace(/\r$/, '')); field = '';
      if (c !== ',') { if (row.some(Boolean)) rows.push(row); row = []; }
    } else field += c;
  }
  const header = rows.shift(); return rows.map(r => Object.fromEntries(header.map((h, i) => [h, r[i] || ''])));
}
function sha(data) { return crypto.createHash('sha256').update(data).digest('hex'); }
function within(root, relative) {
  const resolved = path.resolve(root, relative);
  if (!resolved.startsWith(path.resolve(root) + path.sep)) throw Error('Path outside dataset root');
  return resolved;
}
function chooseTrain(rows, limit) {
  if (!limit || rows.length <= limit) return rows;
  const groups = new Map();
  for (const row of rows) {
    const key = [row.sex, row.octave_tag, row.pitch_register].join('/');
    if (!groups.has(key)) groups.set(key, []); groups.get(key).push(row);
  }
  for (const group of groups.values()) group.sort((a, b) => sha('20261024:' + a.stem).localeCompare(sha('20261024:' + b.stem)));
  const chosen = [], lists = [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(e => e[1]);
  for (let i = 0; chosen.length < limit; i++) for (const group of lists) {
    if (group[i]) chosen.push(group[i]); if (chosen.length === limit) break;
  }
  return chosen;
}

// A candidate with a broader 40-1400 Hz range and a gentler amplitude gate.
// Its numerical kernel is identical to the original YIN except for range/gate.
function wideYin(samples, offset, rate, gate, work) {
  const size = 512, minTau = Math.max(2, Math.floor(rate / 1400)), maxTau = Math.ceil(rate / 40);
  let mean = 0, power = 0;
  for (let i = 0; i < size; i++) mean += samples[offset + i] || 0;
  mean /= size;
  for (let i = 0; i < size; i++) { const x = (samples[offset + i] || 0) - mean; power += x * x; }
  const rms = Math.sqrt(power / size);
  if (rms < gate) return { midi: null, confidence: 0, rms };
  work[0] = 1; let running = 0;
  for (let tau = 1; tau <= maxTau; tau++) {
    let sum = 0;
    for (let i = 0; i < size; i++) { const d = (samples[offset + i] || 0) - (samples[offset + i + tau] || 0); sum += d * d; }
    running += sum; work[tau] = running ? sum * tau / running : 1;
  }
  let best = -1;
  for (let tau = minTau; tau < maxTau; tau++) if (work[tau] < .16) {
    while (tau + 1 < maxTau && work[tau + 1] < work[tau]) tau++; best = tau; break;
  }
  if (best < 0) {
    for (let tau = minTau; tau < maxTau; tau++) if (best < 0 || work[tau] < work[best]) best = tau;
    if (work[best] > .28) return { midi: null, confidence: 0, rms };
  }
  const denominator = 2 * (2 * work[best] - work[best + 1] - work[best - 1]);
  const period = best + (denominator ? (work[best + 1] - work[best - 1]) / denominator : 0), hz = rate / period;
  if (hz < 40 || hz > 1400) return { midi: null, confidence: 0, rms };
  return { midi: 69 + 12 * Math.log2(hz / 440), confidence: Math.max(0, Math.min(1, 1 - work[best])), rms };
}

function extract(input, sourceRate) {
  const begin = performance.now();
  const down = baseline.downsample(input.subarray(0, Math.floor(sourceRate * 30.2)), sourceRate, 8000);
  const data = down.samples, rate = down.sampleRate, hop = Math.round(rate * .015);
  const frameCount = Math.max(0, Math.floor((data.length - 700) / hop));
  let maxRms = 0;
  for (let i = 0; i + 512 < data.length; i += 512) {
    let mean = 0, power = 0;
    for (let j = 0; j < 512; j++) mean += data[i + j]; mean /= 512;
    for (let j = 0; j < 512; j++) power += Math.pow(data[i + j] - mean, 2);
    maxRms = Math.max(maxRms, Math.sqrt(power / 512));
  }
  const oldGate = Math.max(.003, maxRms * .07), wideGate = Math.max(.002, maxRms * .035);
  const oldFrames = [], wideFrames = [], oldWork = new Float32Array(185), wideWork = new Float32Array(205);
  const setupMs = performance.now() - begin; let oldMs = setupMs, wideMs = setupMs;
  for (let i = 0; i < frameCount; i++) {
    let at = performance.now(); oldFrames.push(baseline.yin(data, i * hop, rate, oldGate, oldWork)); oldMs += performance.now() - at;
    at = performance.now(); wideFrames.push(wideYin(data, i * hop, rate, wideGate, wideWork)); wideMs += performance.now() - at;
  }
  return { hop: hop / rate, maxRms, oldFrames, wideFrames, oldMs, wideMs };
}

const cacheVersion = sha('trace-v1:' + fs.readFileSync(path.join(__dirname, 'baseline/pitch.js')) + wideYin.toString());
function cachePath(cache, stem) { if (!/^[\w-]+$/.test(stem)) throw Error('Unsafe sample name'); return path.join(cache, stem + '.json'); }

if (!isMainThread && workerData && workerData.kind === 'extract') {
  parentPort.on('message', row => {
    try {
      const bytes = fs.readFileSync(within(workerData.root, row.wav_path));
      if (sha(bytes) !== row.wav_sha256) throw Error('WAV checksum differs from manifest');
      const wav = decodeWav(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
      const trace = extract(wav.samples, wav.sampleRate);
      const notes = baseline.framesToNotes(trace.oldFrames, trace.hop, 100);
      const record = { version: cacheVersion, row, duration: wav.samples.length / wav.sampleRate,
        sampleRate: wav.sampleRate, hop: trace.hop, maxRms: trace.maxRms,
        midiBase64: fs.readFileSync(within(workerData.root, row.midi_path)).toString('base64'),
        baseline: { frames: trace.oldFrames, notes, ms: trace.oldMs }, wide: { frames: trace.wideFrames, ms: trace.wideMs } };
      fs.writeFileSync(cachePath(workerData.cache, row.stem), JSON.stringify(record));
      parentPort.postMessage({ stem: row.stem, duration: record.duration, notes: notes.length, ms: trace.oldMs + trace.wideMs });
    } catch (error) { parentPort.postMessage({ stem: row.stem, error: error.stack || error.message }); }
  });
} else if (require.main === module) main().catch(error => { console.error(error); process.exitCode = 1; });

function argsFrom(argv) {
  const options = { command: argv[0] };
  for (let i = 1; i < argv.length; i += 2) options[argv[i].replace(/^--/, '')] = argv[i + 1];
  return options;
}
async function main() {
  const options = argsFrom(process.argv.slice(2)), root = path.resolve(options.root || '.');
  const cache = path.resolve(options.cache || 'work/humtrans/cache'); fs.mkdirSync(cache, { recursive: true });
  if (options.command !== 'extract') throw Error('Usage: node tools/humtrans-benchmark.cjs extract --root DATA --splits train_clean,valid_clean --cache CACHE --workers 8 --train-limit 120');
  let rows = [];
  for (const name of (options.splits || 'train_clean,valid_clean').split(',')) {
    if (!/^(train|valid|test)_(clean|strict|robust|all)$/.test(name)) throw Error('Unsupported split');
    let group = csv(fs.readFileSync(path.join(root, 'splits', name + '.csv'), 'utf8'));
    if (name.startsWith('train_')) group = chooseTrain(group, Number(options['train-limit'] || 120));
    rows.push(...group);
  }
  rows = [...new Map(rows.map(r => [r.stem, r])).values()];
  fs.writeFileSync(path.join(cache, 'selection-' + (options.splits || 'train_clean,valid_clean').replace(/,/g, '-') + '.json'), JSON.stringify({ version: cacheVersion, root, samples: rows.map(r => r.stem) }, null, 2));
  const todo = rows.filter(row => {
    try { const v = JSON.parse(fs.readFileSync(cachePath(cache, row.stem), 'utf8')); return v.version !== cacheVersion || v.row.wav_sha256 !== row.wav_sha256; } catch (_) { return true; }
  });
  console.log(JSON.stringify({ selected: rows.length, cached: rows.length - todo.length, toExtract: todo.length, version: cacheVersion }));
  if (!todo.length) return;
  const started = performance.now(), count = Math.min(Number(options.workers || 8), todo.length), errors = [];
  let cursor = 0, completed = 0, audioSeconds = 0;
  await Promise.all(Array.from({ length: count }, () => new Promise((resolve, reject) => {
    const worker = new Worker(__filename, { workerData: { kind: 'extract', root, cache } });
    const dispatch = () => { if (cursor < todo.length) worker.postMessage(todo[cursor++]); else worker.terminate().then(resolve, reject); };
    worker.on('error', reject);
    worker.on('message', result => {
      completed++; audioSeconds += result.duration || 0; if (result.error) errors.push(result);
      if (completed % 20 === 0 || completed === todo.length) console.log(JSON.stringify({ completed, total: todo.length, elapsedSeconds: Math.round((performance.now() - started) / 1000), audioMinutes: +(audioSeconds / 60).toFixed(1), errors: errors.length }));
      dispatch();
    }); dispatch();
  })));
  fs.writeFileSync(path.join(cache, 'extract-errors.json'), JSON.stringify(errors, null, 2));
  if (errors.length) throw Error(errors.length + ' extraction errors; see cache/extract-errors.json');
}

module.exports = { csv, chooseTrain, extract, wideYin, cacheVersion, cachePath };
