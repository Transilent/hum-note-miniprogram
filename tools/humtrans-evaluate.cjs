const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const { Worker, isMainThread, parentPort, workerData } = require('node:worker_threads');
const { performance } = require('node:perf_hooks');
const { csv, chooseTrain, cachePath } = require('./humtrans-benchmark.cjs');
const { normalizeNotes, getOverlaps } = require('../miniprogram/utils/music');
const baseline = require('./baseline/pitch');
const metrics = require('./humtrans-metrics.cjs');
const segment = require('./humtrans-segmentation.cjs');

function variants() {
  const all = [{ id: 'baseline', source: 'baseline', segmentation: null, options: null },
    { id: 'range_only', source: 'wide', segmentation: null, options: null }];
  for (const source of ['baseline', 'wide']) for (const c of segment.CANDIDATES) all.push({ id: source + '/' + c.name, source, segmentation: c.name, options: c.options });
  return all;
}
function predict(x, variant) {
  let notes;
  if (!variant.segmentation) notes = variant.source === 'baseline' ? x.baseline.notes : baseline.framesToNotes(x.wide.frames, x.hop, 100);
  else notes = segment.segmentFrames(x[variant.source].frames, x.hop, 100, variant.options);
  const normalized = normalizeNotes(notes);
  if (getOverlaps(normalized).ids.length) throw Error('Predictions overlap after application normalization');
  return normalized.map(n => ({ start: n.start * .6, end: (n.start + n.duration) * .6, midi: n.midi }));
}
function makeCsv(rows) {
  if (!rows.length) return '';
  const keys = [...new Set(rows.flatMap(r => Object.keys(r)))];
  const q = value => '"' + String(value == null ? '' : value).replace(/"/g, '""') + '"';
  return keys.map(q).join(',') + '\n' + rows.map(r => keys.map(k => q(r[k])).join(',')).join('\n') + '\n';
}
function hashFile(file) { return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'); }
function grouped(records) {
  const out = {};
  for (const field of ['sex', 'octave_tag', 'person_id', 'pitch_register', 'duration_bucket', 'strict_time']) {
    out[field] = {};
    for (const value of new Set(records.map(r => r[field]))) out[field][value] = metrics.aggregate(records.filter(r => r[field] === value));
  }
  return out;
}
if (!isMainThread && workerData && workerData.kind === 'score') {
  parentPort.on('message', stem => {
    try {
      const x = JSON.parse(fs.readFileSync(cachePath(workerData.cache, stem), 'utf8'));
      const ref = metrics.readMidi(Buffer.from(x.midiBase64, 'base64'));
      if (ref.length !== Number(x.row.midi_notes)) throw Error('MIDI parser count differs from audit');
      const rows = [];
      for (const variant of workerData.variants) {
        const start = performance.now(); let scores, failure = '';
        try { scores = metrics.scoreNotes(ref, predict(x, variant), { duration: x.duration, hop: x.hop }); }
        catch (error) { failure = error.message; scores = metrics.scoreNotes(ref, [], { duration: x.duration, hop: x.hop }); }
        rows.push({ stem, variant: variant.id, split: x.row.split, composition_id: x.row.composition_id,
          sex: x.row.sex, octave_tag: x.row.octave_tag, person_id: x.row.person_id, pitch_register: x.row.pitch_register,
          duration_bucket: x.row.duration_bucket, strict_time: x.row.recommended_strict_time,
          duration_s: x.duration, quality_class: x.row.quality_class, failure,
          feature_ms: x[variant.source].ms, postprocess_and_score_ms: performance.now() - start, ...scores });
      }
      parentPort.postMessage({ rows });
    } catch (error) { parentPort.postMessage({ error: stem + ': ' + error.stack }); }
  });
} else if (require.main === module) main().catch(error => { console.error(error); process.exitCode = 1; });

async function main() {
  const argv = process.argv.slice(2), mode = argv.shift(), options = {};
  for (let i = 0; i < argv.length; i += 2) options[argv[i].replace(/^--/, '')] = argv[i + 1];
  const root = path.resolve(options.root), cache = path.resolve(options.cache), out = path.resolve(options.out);
  const segmentationHash = hashFile(path.join(__dirname, 'humtrans-segmentation.cjs'));
  const metricsHash = hashFile(path.join(__dirname, 'humtrans-metrics.cjs'));
  fs.mkdirSync(out, { recursive: true });
  let chosen, selection;
  if (mode === 'calibrate') {
    chosen = csv(fs.readFileSync(path.join(root, 'splits/valid_clean.csv'), 'utf8'));
    selection = variants();
  } else if (mode === 'test') {
    chosen = csv(fs.readFileSync(path.join(root, 'splits/test_clean.csv'), 'utf8'));
    const frozen = JSON.parse(fs.readFileSync(path.join(out, 'selection.json'), 'utf8'));
    if (frozen.segmentation_sha256 !== hashFile(path.join(__dirname, 'humtrans-segmentation.cjs'))) throw Error('Segmentation changed after validation selection');
    for (const [field, file] of [['baseline_sha256', 'baseline/pitch.js'], ['feature_extractor_sha256', 'humtrans-benchmark.cjs'], ['metrics_sha256', 'humtrans-metrics.cjs'], ['evaluation_driver_sha256', 'humtrans-evaluate.cjs']]) {
      if (!frozen[field] || frozen[field] !== hashFile(path.join(__dirname, file))) throw Error('Frozen code hash mismatch: ' + field);
    }
    if (frozen.validation_split_sha256 !== hashFile(path.join(root, 'splits/valid_clean.csv')) || frozen.test_split_sha256 !== hashFile(path.join(root, 'splits/test_clean.csv'))) throw Error('Dataset split changed after selection');
    selection = [variants()[0], frozen.selected];
  } else throw Error('Expected calibrate or test');
  console.log(JSON.stringify({ mode, samples: chosen.length, variants: selection.length, compositions: new Set(chosen.map(r => r.composition_id)).size }));
  const begin = performance.now(), all = [], errors = []; let cursor = 0, done = 0;
  const count = Math.min(Number(options.workers || 8), chosen.length);
  await Promise.all(Array.from({ length: count }, () => new Promise((resolve, reject) => {
    const worker = new Worker(__filename, { workerData: { kind: 'score', cache, variants: selection } });
    const dispatch = () => { if (cursor < chosen.length) worker.postMessage(chosen[cursor++].stem); else worker.terminate().then(resolve, reject); };
    worker.on('error', reject);
    worker.on('message', result => {
      done++; if (result.error) errors.push(result.error); else all.push(...result.rows);
      if (done % 100 === 0 || done === chosen.length) console.log(JSON.stringify({ completed: done, total: chosen.length, elapsedSeconds: +((performance.now() - begin) / 1000).toFixed(1), errors: errors.length }));
      dispatch();
    }); dispatch();
  })));
  if (errors.length) { fs.writeFileSync(path.join(out, mode + '-errors.json'), JSON.stringify(errors, null, 2)); throw Error(errors[0]); }
  if (segmentationHash !== hashFile(path.join(__dirname, 'humtrans-segmentation.cjs')) || metricsHash !== hashFile(path.join(__dirname, 'humtrans-metrics.cjs'))) throw Error('Evaluation code changed during the run; rerun after review is complete');
  all.sort((a, b) => a.variant.localeCompare(b.variant) || a.stem.localeCompare(b.stem));
  const summary = {};
  for (const variant of selection) {
    const records = all.filter(r => r.variant === variant.id), aggregate = metrics.aggregate(records);
    summary[variant.id] = { ...aggregate, failures: records.filter(r => r.failure).length,
      selection_objective: (aggregate.metrics.melody_lcs_f1 + aggregate.metrics.frame_pc_recall) / 2,
      groups: grouped(records) };
  }
  fs.writeFileSync(path.join(out, mode + '-per-sample.csv'), makeCsv(all));
  fs.writeFileSync(path.join(out, mode + '-metrics.json'), JSON.stringify({ mode, samples: chosen.length, composition_macro: true, scoring: 'fixed-time; no temporal shift; note F1 uses global octave search; frame/LCS use pitch class', summary }, null, 2));
  if (mode === 'calibrate') {
    const ranked = selection.filter(v => !summary[v.id].failures).sort((a, b) => summary[b.id].selection_objective - summary[a.id].selection_objective || summary[b.id].metrics.note_f100 - summary[a.id].metrics.note_f100);
    const selected = ranked[0];
    const frozen = { protocol: 'Selected only on all 721 valid_clean recordings; no test scores used.', objective: 'Equal-weight mean of composition-macro melody_lcs_f1 and frame_pc_recall',
      selected, validation: summary[selected.id], validation_samples: chosen.length,
      baseline_sha256: hashFile(path.join(__dirname, 'baseline/pitch.js')),
      segmentation_sha256: hashFile(path.join(__dirname, 'humtrans-segmentation.cjs')),
      feature_extractor_sha256: hashFile(path.join(__dirname, 'humtrans-benchmark.cjs')),
      metrics_sha256: hashFile(path.join(__dirname, 'humtrans-metrics.cjs')),
      evaluation_driver_sha256: hashFile(path.join(__dirname, 'humtrans-evaluate.cjs')),
      validation_split_sha256: hashFile(path.join(root, 'splits/valid_clean.csv')),
      test_split_sha256: hashFile(path.join(root, 'splits/test_clean.csv')), test_used_for_selection: false };
    fs.writeFileSync(path.join(out, 'selection.json'), JSON.stringify(frozen, null, 2));
  }
  console.log(JSON.stringify(selection.map(v => ({ variant: v.id, objective: summary[v.id].selection_objective, lcs: summary[v.id].metrics.melody_lcs_f1, frame: summary[v.id].metrics.frame_pc_recall, f50: summary[v.id].metrics.note_f50, f100: summary[v.id].metrics.note_f100, ratio: summary[v.id].metrics.ratio, failures: summary[v.id].failures })).sort((a, b) => b.objective - a.objective), null, 2));
}
module.exports = { variants, predict, makeCsv, grouped };
